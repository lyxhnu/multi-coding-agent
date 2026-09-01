#!/usr/bin/env python3
"""Download a Docker Hub image via host networking and write a docker-load tar."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import tarfile
import tempfile
import time
from pathlib import Path
from urllib.parse import urlencode

import requests

INDEX_ACCEPT = ", ".join([
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
])
MANIFEST_ACCEPT = ", ".join([
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
])


def normalize_ref(ref: str) -> tuple[str, str, str]:
    if ":" in ref.rsplit("/", 1)[-1]:
        name, tag = ref.rsplit(":", 1)
    else:
        name, tag = ref, "latest"
    if "/" not in name:
        repo = f"library/{name}"
        repo_tag = f"{name}:{tag}"
    else:
        repo = name
        repo_tag = f"{name}:{tag}"
    return "registry-1.docker.io", repo, repo_tag


# Docker Hub throttles anonymous clients hard (HTTP 429). Every request path
# below shares the same policy: honor Retry-After when present, otherwise back
# off exponentially, and keep waiting long enough to outlast a rate-limit window.
RATE_LIMIT_WAITS = (30, 60, 120, 300, 600, 900, 900, 900, 900, 900)


def _sleep_for_rate_limit(resp, attempt: int, what: str) -> None:
    hinted = 0
    if resp is not None:
        try:
            hinted = int(resp.headers.get("Retry-After", "0"))
        except ValueError:
            hinted = 0
    wait = max(hinted, RATE_LIMIT_WAITS[min(attempt, len(RATE_LIMIT_WAITS) - 1)])
    print(f"  rate limited on {what}; waiting {wait}s (attempt {attempt + 1})", flush=True)
    time.sleep(wait)


def request_json(url: str, headers: dict[str, str] | None = None) -> dict:
    last = None
    for attempt in range(12):
        r = requests.get(url, headers=headers or {}, timeout=60)
        last = r
        if r.status_code == 429:
            _sleep_for_rate_limit(r, attempt, "manifest")
            continue
        if r.status_code < 500:
            r.raise_for_status()
            return r.json()
        time.sleep(min(2 ** attempt, 60))
    last.raise_for_status()
    return last.json()


def get_token(repo: str) -> str:
    query = urlencode({"service": "registry.docker.io", "scope": f"repository:{repo}:pull"})
    data = request_json(f"https://auth.docker.io/token?{query}")
    return data["token"]


def get_json(registry: str, repo: str, ref: str, token: str, accept: str) -> dict:
    url = f"https://{registry}/v2/{repo}/manifests/{ref}"
    return request_json(url, {"Authorization": f"Bearer {token}", "Accept": accept})


def select_manifest(index: dict, arch: str, os_name: str) -> str:
    for item in index.get("manifests", []):
        platform = item.get("platform") or {}
        if platform.get("os") == os_name and platform.get("architecture") == arch:
            return item["digest"]
    available = [m.get("platform", {}) for m in index.get("manifests", [])]
    raise SystemExit(f"No manifest for {os_name}/{arch}. Available: {available[:10]}")


def download_blob(registry: str, repo: str, digest: str, token: str, dest: Path) -> str:
    """Download a blob, refreshing the token on 401 and waiting out 429s.
    Returns the (possibly refreshed) token for subsequent calls."""
    url = f"https://{registry}/v2/{repo}/blobs/{digest}"
    last_exc: Exception | None = None
    for attempt in range(12):
        try:
            headers = {"Authorization": f"Bearer {token}"}
            with requests.get(url, headers=headers, stream=True, timeout=120) as r:
                if r.status_code == 401:
                    token = get_token(repo)
                    continue
                if r.status_code == 429:
                    _sleep_for_rate_limit(r, attempt, "blob")
                    token = get_token(repo)
                    continue
                r.raise_for_status()
                with dest.open("wb") as f:
                    for chunk in r.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            f.write(chunk)
            return token
        except requests.RequestException as e:
            last_exc = e
            time.sleep(min(2 ** attempt, 60))
    raise last_exc if last_exc else RuntimeError(f"blob download failed: {digest}")


def maybe_decompress(src: Path, dest: Path) -> None:
    with src.open("rb") as f:
        magic = f.read(2)
    if magic == b"\x1f\x8b":
        with gzip.open(src, "rb") as gz, dest.open("wb") as out:
            while True:
                chunk = gz.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
    else:
        dest.write_bytes(src.read_bytes())


def add_bytes(tf: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mtime = int(time.time())
    tf.addfile(info, io.BytesIO(data))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", help="Docker Hub image ref, e.g. python:3.13-slim-bookworm")
    parser.add_argument("--arch", default="arm64")
    parser.add_argument("--os", default="linux")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    registry, repo, repo_tag = normalize_ref(args.image)
    tag = repo_tag.rsplit(":", 1)[1]
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    token = get_token(repo)
    index_or_manifest = get_json(registry, repo, tag, token, INDEX_ACCEPT)
    if "manifests" in index_or_manifest:
        digest = select_manifest(index_or_manifest, args.arch, args.os)
        manifest = get_json(registry, repo, digest, token, MANIFEST_ACCEPT)
    else:
        manifest = index_or_manifest

    config_digest = manifest["config"]["digest"]
    config_name = config_digest.split(":", 1)[1] + ".json"
    layers = manifest["layers"]
    layer_names: list[str] = []

    with tempfile.TemporaryDirectory() as tmpdir, tarfile.open(output, "w") as tf:
        tmp = Path(tmpdir)
        config_path = tmp / config_name
        print(f"Downloading config {config_digest}")
        token = download_blob(registry, repo, config_digest, token, config_path)
        add_bytes(tf, config_name, config_path.read_bytes())

        for i, layer in enumerate(layers):
            digest = layer["digest"]
            hex_digest = digest.split(":", 1)[1]
            compressed = tmp / f"{i:03d}.blob"
            uncompressed = tmp / f"{i:03d}.tar"
            layer_name = f"{i:03d}_{hex_digest}/layer.tar"
            print(f"Downloading layer {i + 1}/{len(layers)} {digest}")
            token = download_blob(registry, repo, digest, token, compressed)
            maybe_decompress(compressed, uncompressed)
            info = tarfile.TarInfo(layer_name)
            info.size = uncompressed.stat().st_size
            info.mtime = int(time.time())
            with uncompressed.open("rb") as f:
                tf.addfile(info, f)
            layer_names.append(layer_name)

        manifest_json = [{"Config": config_name, "RepoTags": [repo_tag], "Layers": layer_names}]
        add_bytes(tf, "manifest.json", json.dumps(manifest_json).encode())
        add_bytes(tf, "repositories", json.dumps({repo_tag.rsplit(':', 1)[0]: {repo_tag.rsplit(':', 1)[1]: config_name[:-5]}}).encode())

    print(f"Wrote {output} ({output.stat().st_size / (1024 * 1024):.1f} MiB)")


if __name__ == "__main__":
    main()
