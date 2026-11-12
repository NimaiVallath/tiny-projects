#!/usr/bin/env python3
"""Focused checks for Archive Glass path and archive handling."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

from archive_glass import normalize_path, scan_archive


class ArchiveGlassTests(unittest.TestCase):
    def test_normalization_handles_windows_separators_and_root_escape(self) -> None:
        self.assertEqual(normalize_path(r"images\season\..\sunrise.jpg"), ("images/sunrise.jpg", False))
        self.assertEqual(normalize_path("../../outside.txt"), ("outside.txt", True))
        self.assertEqual(normalize_path("C:\\temp\\payload.dll"), ("C:/temp/payload.dll", True))

    def test_clean_zip_has_no_obvious_risk_and_never_extracts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "clean.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("docs/readme.txt", "hello")
            report = scan_archive(archive)
            self.assertEqual(report["assessment"], "no-obvious-risk")
            self.assertEqual(report["entries_scanned"], 1)
            self.assertFalse((Path(directory) / "docs").exists())

    def test_zip_path_traversal_and_canonical_duplicates_are_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "paths.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("../../outside.txt", "x")
                output.writestr("folder/../same.txt", "x")
                output.writestr("same.txt", "x")
            report = scan_archive(archive)
            codes = [finding["code"] for finding in report["findings"]]
            self.assertEqual(report["assessment"], "blocked")
            self.assertIn("unsafe-path", codes)
            self.assertIn("duplicate-path", codes)

    def test_symlink_escape_and_descendant_are_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "links.zip"
            link = zipfile.ZipInfo("shortcut")
            link.create_system = 3
            link.external_attr = (0o120777 << 16)
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr(link, "../../outside")
                output.writestr("shortcut/child.txt", "x")
            report = scan_archive(archive)
            codes = [finding["code"] for finding in report["findings"]]
            self.assertIn("unsafe-link", codes)
            self.assertIn("symlink-parent", codes)
            self.assertEqual(report["assessment"], "blocked")

    def test_tar_device_entries_need_manual_review(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "device.tar"
            info = tarfile.TarInfo("dev/tty")
            info.type = tarfile.CHRTYPE
            info.devmajor = 4
            info.devminor = 1
            with tarfile.open(archive, "w:") as output:
                output.addfile(info)
            report = scan_archive(archive)
            self.assertEqual(report["assessment"], "review")
            self.assertEqual(report["findings"][0]["code"], "special-file")

    def test_file_cannot_be_used_as_another_entry_parent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "conflict.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("node", "file")
                output.writestr("node/child.txt", "child")
            report = scan_archive(archive)
            self.assertEqual(report["assessment"], "blocked")
            self.assertIn("path-parent-conflict", [finding["code"] for finding in report["findings"]])

    def test_compression_ratio_and_entry_limit_are_visible(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "limits.zip"
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
                output.writestr("repeat.txt", "a" * 20_000)
                output.writestr("second.txt", "small")
            ratio = scan_archive(archive)
            self.assertEqual(ratio["assessment"], "review")
            self.assertIn("compression-ratio", [finding["code"] for finding in ratio["findings"]])
            limited = scan_archive(archive, max_entries=1)
            self.assertTrue(limited["incomplete"])
            self.assertEqual(limited["assessment"], "blocked")

    def test_size_budget_stops_incomplete_and_validation_rejects_zero(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "large.zip"
            with zipfile.ZipFile(archive, "w") as output:
                output.writestr("first.txt", "12345")
                output.writestr("later.txt", "67890")
            report = scan_archive(archive, max_bytes=6)
            self.assertTrue(report["incomplete"])
            self.assertEqual(report["entries_scanned"], 1)
            self.assertEqual(report["assessment"], "blocked")
            with self.assertRaisesRegex(ValueError, "limits must be positive"):
                scan_archive(archive, max_entries=0)

    def test_demo_cli_prints_machine_readable_blocked_report(self) -> None:
        script = Path(__file__).with_name("archive_glass.py")
        result = subprocess.run([sys.executable, str(script), "--demo"], text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 1)
        report = json.loads(result.stdout)
        expected = json.loads((Path(__file__).parent / "examples" / "demo.json").read_text(encoding="utf-8"))
        self.assertEqual(report, expected)
        self.assertEqual(report["assessment"], "blocked")
        self.assertIn("unsafe-path", [finding["code"] for finding in report["findings"]])

    def test_only_supported_extensions_are_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            unsupported = Path(directory) / "archive.tgz"
            unsupported.touch()
            with self.assertRaisesRegex(ValueError, "supported formats"):
                scan_archive(unsupported)


if __name__ == "__main__":
    unittest.main()
