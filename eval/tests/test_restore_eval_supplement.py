from __future__ import annotations

import hashlib
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from restore_eval_supplement import restore  # noqa: E402


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class RestoreEvalSupplementTest(unittest.TestCase):
    def make_delivery(self, directory: Path) -> tuple[Path, Path, Path, dict[str, bytes]]:
        snapshot = directory / "PROJECT_SNAPSHOT.md"
        archive = directory / "pi-eval-supplement.tar.gz"
        manifest = directory / "pi-eval-supplement.manifest.json"
        snapshot.write_bytes(b"snapshot")
        files = {
            "eval/assets/node-v22.23.2-linux-x64.tar.gz": b"node",
            "eval/local_tasks/tb2_all/task/instruction.md": b"instruction",
        }
        with tarfile.open(archive, "w:gz") as handle:
            for relative, content in files.items():
                info = tarfile.TarInfo(relative)
                info.size = len(content)
                info.mode = 0o644
                handle.addfile(info, io.BytesIO(content))
        archive_bytes = archive.read_bytes()
        manifest.write_text(
            json.dumps(
                {
                    "format_version": 1,
                    "snapshot": {"sha256": sha256(snapshot.read_bytes())},
                    "archive": {"size": len(archive_bytes), "sha256": sha256(archive_bytes)},
                    "files": [
                        {
                            "path": relative,
                            "size": len(content),
                            "sha256": sha256(content),
                            "mode": "0644",
                        }
                        for relative, content in files.items()
                    ],
                }
            ),
            encoding="utf-8",
        )
        return snapshot, archive, manifest, files

    def test_restores_and_then_skips_identical_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "pi-main"
            root.mkdir()
            snapshot, archive, manifest, files = self.make_delivery(base)
            self.assertEqual(restore(root, snapshot, archive, manifest, False), (2, 0, 0))
            self.assertEqual(restore(root, snapshot, archive, manifest, False), (0, 2, 0))
            for relative, content in files.items():
                self.assertEqual(root.joinpath(*relative.split("/")).read_bytes(), content)

    def test_rejects_different_existing_file_without_force(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "pi-main"
            root.mkdir()
            snapshot, archive, manifest, _ = self.make_delivery(base)
            target = root / "eval" / "assets" / "node-v22.23.2-linux-x64.tar.gz"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"different")
            with self.assertRaisesRegex(ValueError, "before using --force"):
                restore(root, snapshot, archive, manifest, False)
            self.assertEqual(target.read_bytes(), b"different")

    def test_force_overwrites_only_after_archive_validation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "pi-main"
            root.mkdir()
            snapshot, archive, manifest, files = self.make_delivery(base)
            target = root / "eval" / "assets" / "node-v22.23.2-linux-x64.tar.gz"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"different")
            self.assertEqual(restore(root, snapshot, archive, manifest, True), (1, 0, 1))
            self.assertEqual(target.read_bytes(), files["eval/assets/node-v22.23.2-linux-x64.tar.gz"])

    def test_rejects_snapshot_binding_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "pi-main"
            root.mkdir()
            snapshot, archive, manifest, _ = self.make_delivery(base)
            snapshot.write_bytes(b"wrong snapshot")
            with self.assertRaisesRegex(ValueError, "snapshot sha256 mismatch"):
                restore(root, snapshot, archive, manifest, False)


if __name__ == "__main__":
    unittest.main()
