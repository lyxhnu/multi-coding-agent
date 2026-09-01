#!/usr/bin/env python3
"""Restore the TB2 supplement after verifying its snapshot binding and contents.

The manifest schema is intentionally singular:

{
  "format_version": 1,
  "snapshot": {"sha256": "..."},
  "archive": {"size": 123, "sha256": "..."},
  "files": [
    {"path": "eval/assets/file", "size": 123, "sha256": "...", "mode": "0644"}
  ]
}

Paths are relative to --root. Archive members must be regular files listed in
the manifest or directory entries needed to contain them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO


@dataclass(frozen=True)
class FileRecord:
    path: str
    size: int
    sha256: str
    mode: int | None


@dataclass(frozen=True)
class SupplementManifest:
    snapshot_sha256: str
    archive_size: int
    archive_sha256: str
    files: tuple[FileRecord, ...]


def sha256_stream(handle: BinaryIO) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        size += len(chunk)
        digest.update(chunk)
    return size, digest.hexdigest()


def sha256_file(path: Path) -> tuple[int, str]:
    with path.open("rb") as handle:
        return sha256_stream(handle)


def require_sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or len(value) != 64:
        raise ValueError(f"{label} must be a 64-character sha256")
    try:
        int(value, 16)
    except ValueError as error:
        raise ValueError(f"{label} must be hexadecimal") from error
    return value.lower()


def safe_relative_path(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("manifest file path must be a string")
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or ".." in path.parts or "." in path.parts:
        raise ValueError(f"unsafe supplement path: {value}")
    normalized = path.as_posix()
    if normalized != value:
        raise ValueError(f"supplement path is not normalized: {value}")
    return normalized


def parse_mode(value: object, path: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        mode = value
    elif isinstance(value, str):
        try:
            mode = int(value, 8)
        except ValueError as error:
            raise ValueError(f"invalid mode for {path}: {value}") from error
    else:
        raise ValueError(f"invalid mode for {path}: {value}")
    if mode < 0 or mode > 0o7777:
        raise ValueError(f"mode out of range for {path}: {value}")
    return mode


def load_manifest(path: Path) -> SupplementManifest:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("format_version") != 1:
        raise ValueError("unsupported supplement manifest format_version")
    snapshot = data.get("snapshot")
    archive = data.get("archive")
    raw_files = data.get("files")
    if not isinstance(snapshot, dict) or not isinstance(archive, dict) or not isinstance(raw_files, list):
        raise ValueError("manifest requires snapshot, archive, and files")
    archive_size = archive.get("size")
    if not isinstance(archive_size, int) or archive_size < 0:
        raise ValueError("archive.size must be a non-negative integer")

    files: list[FileRecord] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_files):
        if not isinstance(item, dict):
            raise ValueError(f"files[{index}] must be an object")
        relative = safe_relative_path(item.get("path"))
        if relative in seen:
            raise ValueError(f"duplicate supplement path: {relative}")
        seen.add(relative)
        size = item.get("size")
        if not isinstance(size, int) or size < 0:
            raise ValueError(f"invalid size for {relative}")
        files.append(
            FileRecord(
                path=relative,
                size=size,
                sha256=require_sha256(item.get("sha256"), f"files[{index}].sha256"),
                mode=parse_mode(item.get("mode"), relative),
            )
        )

    return SupplementManifest(
        snapshot_sha256=require_sha256(snapshot.get("sha256"), "snapshot.sha256"),
        archive_size=archive_size,
        archive_sha256=require_sha256(archive.get("sha256"), "archive.sha256"),
        files=tuple(files),
    )


def destination_for(root: Path, relative: str) -> Path:
    destination = root.joinpath(*PurePosixPath(relative).parts)
    root_resolved = root.resolve()
    parent_resolved = destination.parent.resolve(strict=False)
    if parent_resolved != root_resolved and root_resolved not in parent_resolved.parents:
        raise ValueError(f"supplement path escapes root: {relative}")
    return destination


def validate_delivery(snapshot: Path, archive: Path, manifest: SupplementManifest) -> None:
    _, snapshot_sha256 = sha256_file(snapshot)
    if snapshot_sha256 != manifest.snapshot_sha256:
        raise ValueError(
            f"snapshot sha256 mismatch: expected {manifest.snapshot_sha256}, got {snapshot_sha256}"
        )
    archive_size, archive_sha256 = sha256_file(archive)
    if archive_size != manifest.archive_size:
        raise ValueError(
            f"archive size mismatch: expected {manifest.archive_size}, got {archive_size}"
        )
    if archive_sha256 != manifest.archive_sha256:
        raise ValueError(
            f"archive sha256 mismatch: expected {manifest.archive_sha256}, got {archive_sha256}"
        )


def validated_members(
    archive: tarfile.TarFile, manifest: SupplementManifest
) -> dict[str, tarfile.TarInfo]:
    expected = {record.path: record for record in manifest.files}
    members: dict[str, tarfile.TarInfo] = {}
    for member in archive.getmembers():
        relative = safe_relative_path(member.name.rstrip("/"))
        if member.isdir():
            continue
        if not member.isfile():
            raise ValueError(f"supplement contains non-regular member: {member.name}")
        if relative not in expected:
            raise ValueError(f"supplement contains unlisted file: {relative}")
        if relative in members:
            raise ValueError(f"supplement contains duplicate member: {relative}")
        members[relative] = member

    missing = sorted(set(expected) - set(members))
    if missing:
        raise ValueError(f"supplement archive is missing {len(missing)} file(s): {missing[:5]}")

    for relative, member in members.items():
        record = expected[relative]
        if member.size != record.size:
            raise ValueError(
                f"archive member size mismatch for {relative}: expected {record.size}, got {member.size}"
            )
        extracted = archive.extractfile(member)
        if extracted is None:
            raise ValueError(f"cannot read archive member: {relative}")
        size, sha256 = sha256_stream(extracted)
        if size != record.size or sha256 != record.sha256:
            raise ValueError(f"archive member sha256 mismatch: {relative}")
    return members


def verify_restored_files(root: Path, manifest: SupplementManifest) -> None:
    errors: list[str] = []
    for record in manifest.files:
        destination = destination_for(root, record.path)
        try:
            info = destination.lstat()
        except FileNotFoundError:
            errors.append(f"missing: {record.path}")
            continue
        if destination.is_symlink() or not stat.S_ISREG(info.st_mode):
            errors.append(f"not a regular file: {record.path}")
            continue
        size, sha256 = sha256_file(destination)
        if size != record.size or sha256 != record.sha256:
            errors.append(f"content mismatch: {record.path}")
    if errors:
        raise ValueError("restored supplement verification failed:\n" + "\n".join(errors[:20]))


def restore(
    root: Path,
    snapshot: Path,
    archive_path: Path,
    manifest_path: Path,
    force: bool,
) -> tuple[int, int, int]:
    root = root.resolve()
    if not root.is_dir():
        raise ValueError(f"root is not a directory: {root}")
    manifest = load_manifest(manifest_path)
    validate_delivery(snapshot, archive_path, manifest)

    with tarfile.open(archive_path, "r:gz") as archive:
        members = validated_members(archive, manifest)
        actions: list[tuple[FileRecord, Path, str]] = []
        for record in manifest.files:
            destination = destination_for(root, record.path)
            if not destination.exists() and not destination.is_symlink():
                actions.append((record, destination, "restore"))
                continue
            if destination.is_symlink() or not destination.is_file():
                raise ValueError(f"destination is not a regular file: {record.path}")
            size, sha256 = sha256_file(destination)
            if size == record.size and sha256 == record.sha256:
                actions.append((record, destination, "skip"))
            elif force:
                actions.append((record, destination, "overwrite"))
            else:
                raise ValueError(
                    f"destination differs from supplement: {record.path}; inspect it before using --force"
                )

        restored = skipped = overwritten = 0
        for record, destination, action in actions:
            if action == "skip":
                skipped += 1
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            member = members[record.path]
            extracted = archive.extractfile(member)
            if extracted is None:
                raise ValueError(f"cannot read archive member: {record.path}")
            temp_name: str | None = None
            try:
                with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temp:
                    temp_name = temp.name
                    for chunk in iter(lambda: extracted.read(1024 * 1024), b""):
                        temp.write(chunk)
                os.replace(temp_name, destination)
                temp_name = None
                if record.mode is not None:
                    destination.chmod(record.mode)
            finally:
                if temp_name is not None:
                    Path(temp_name).unlink(missing_ok=True)
            if action == "overwrite":
                overwritten += 1
            else:
                restored += 1

    verify_restored_files(root, manifest)
    return restored, skipped, overwritten


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    restored, skipped, overwritten = restore(
        args.root, args.snapshot, args.archive, args.manifest, args.force
    )
    total = restored + skipped + overwritten
    print(
        f"verified {total} supplement files: restored={restored}, "
        f"skipped={skipped}, overwritten={overwritten}"
    )


if __name__ == "__main__":
    main()
