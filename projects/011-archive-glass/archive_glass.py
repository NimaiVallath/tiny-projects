#!/usr/bin/env python3
"""Inspect ZIP and uncompressed TAR metadata before extraction."""

from __future__ import annotations

import argparse
from dataclasses import asdict, dataclass
import json
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import tempfile
import zipfile


DEFAULT_MAX_ENTRIES = 20_000
DEFAULT_MAX_BYTES = 512 * 1024 * 1024
DEFAULT_MAX_RATIO = 200.0


@dataclass(frozen=True)
class Entry:
    path: str
    kind: str
    size: int
    compressed_size: int | None = None
    link_target: str | None = None


@dataclass(frozen=True)
class Finding:
    code: str
    severity: str
    path: str
    message: str


def normalize_path(raw_path: str) -> tuple[str, bool]:
    """Return a slash-normalized archive path and whether it escapes its root."""
    path = raw_path.replace("\\", "/")
    absolute = path.startswith("/") or bool(re.match(r"^[A-Za-z]:", path))
    parts: list[str] = []
    escaped = absolute
    for part in path.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            if parts:
                parts.pop()
            else:
                escaped = True
            continue
        parts.append(part)
    return "/".join(parts), escaped


def _zip_entries(path: Path, max_entries: int, max_bytes: int) -> tuple[list[Entry], list[Finding], bool]:
    entries: list[Entry] = []
    findings: list[Finding] = []
    total_size = 0
    incomplete = False
    with zipfile.ZipFile(path) as archive:
        for index, info in enumerate(archive.infolist()):
            if index >= max_entries:
                incomplete = True
                findings.append(Finding("entry-limit", "warning", "", f"Scan stopped after {max_entries} entries."))
                break
            if total_size + info.file_size > max_bytes:
                incomplete = True
                findings.append(Finding("size-limit", "warning", info.filename, f"Declared content exceeds the {max_bytes}-byte scan budget; later entries were not inspected."))
                break
            total_size += info.file_size
            mode = info.external_attr >> 16
            is_link = stat.S_ISLNK(mode)
            kind = "symlink" if is_link else "directory" if info.is_dir() else "file"
            if info.flag_bits & 0x1:
                findings.append(Finding("encrypted-entry", "warning", info.filename, "Encrypted entry metadata cannot be fully assessed without a password."))
            target = None
            if is_link:
                # Link payloads are tiny metadata. Read only a bounded prefix; never
                # expand regular file contents while auditing an archive.
                with archive.open(info) as source:
                    payload = source.read(4097)
                if len(payload) > 4096:
                    target = "<target-too-long>"
                else:
                    target = payload.decode("utf-8", errors="replace")
            entries.append(Entry(info.filename, kind, info.file_size, info.compress_size, target))
            if info.file_size and info.compress_size == 0:
                findings.append(Finding("compression-ratio", "warning", info.filename, "Non-empty entry declares zero compressed bytes."))
            elif info.compress_size and info.file_size / info.compress_size > DEFAULT_MAX_RATIO:
                findings.append(Finding("compression-ratio", "warning", info.filename, f"Declared expansion ratio exceeds {DEFAULT_MAX_RATIO:g}:1."))
    return entries, findings, incomplete


def _tar_entries(path: Path, max_entries: int, max_bytes: int) -> tuple[list[Entry], list[Finding], bool]:
    entries: list[Entry] = []
    findings: list[Finding] = []
    total_size = 0
    incomplete = False
    # Random-access mode is intentional: compressed TAR streams can consume
    # unbounded CPU before their declared member sizes can be checked.
    with tarfile.open(path, mode="r:") as archive:
        for index, member in enumerate(archive):
            if index >= max_entries:
                incomplete = True
                findings.append(Finding("entry-limit", "warning", "", f"Scan stopped after {max_entries} entries."))
                break
            if member.size < 0:
                findings.append(Finding("invalid-size", "error", member.name, "Entry declares a negative size."))
                size = 0
            else:
                size = member.size
            if total_size + size > max_bytes:
                incomplete = True
                findings.append(Finding("size-limit", "warning", member.name, f"Declared content exceeds the {max_bytes}-byte scan budget; later entries were not inspected."))
                break
            total_size += size
            if member.isdir():
                kind = "directory"
            elif member.isfile():
                kind = "file"
            elif member.issym():
                kind = "symlink"
            elif member.islnk():
                kind = "hardlink"
            else:
                kind = "special"
            entries.append(Entry(member.name, kind, size, None, member.linkname if member.issym() or member.islnk() else None))
    return entries, findings, incomplete


def scan_archive(path: Path, max_entries: int = DEFAULT_MAX_ENTRIES, max_bytes: int = DEFAULT_MAX_BYTES) -> dict[str, object]:
    """Audit archive metadata without extracting regular files."""
    if max_entries < 1 or max_bytes < 1:
        raise ValueError("scan limits must be positive")
    suffix = path.suffix.lower()
    if suffix == ".zip":
        entries, findings, incomplete = _zip_entries(path, max_entries, max_bytes)
        archive_format = "zip"
    elif suffix == ".tar":
        entries, findings, incomplete = _tar_entries(path, max_entries, max_bytes)
        archive_format = "tar"
    else:
        raise ValueError("supported formats are .zip and uncompressed .tar")

    normalized: dict[str, Entry] = {}
    path_kinds: dict[str, str] = {}
    link_paths: set[str] = set()
    for entry in entries:
        clean_path, escapes = normalize_path(entry.path)
        if escapes or not clean_path:
            findings.append(Finding("unsafe-path", "error", entry.path, "Path is absolute, empty, or traverses above the extraction root."))
        if clean_path in normalized:
            findings.append(Finding("duplicate-path", "error", entry.path, f"Path normalizes to an already-listed entry: {clean_path}."))
        else:
            normalized[clean_path] = entry
            path_kinds[clean_path] = entry.kind
        if entry.kind in ("symlink", "hardlink"):
            link_paths.add(clean_path)
            if not entry.link_target or entry.link_target == "<target-too-long>":
                findings.append(Finding("unsafe-link", "error", entry.path, "Link target is missing or too long to inspect safely."))
            else:
                target, target_escapes = normalize_path(entry.link_target if entry.kind == "hardlink" else str(PurePosixPath(clean_path).parent / entry.link_target))
                if target_escapes:
                    findings.append(Finding("unsafe-link", "error", entry.path, "Link target resolves outside the extraction root."))
        elif entry.kind == "special":
            findings.append(Finding("special-file", "warning", entry.path, "Device, FIFO, or other special entry needs manual review."))

    for entry in entries:
        clean_path, escaped = normalize_path(entry.path)
        if escaped:
            continue
        parts = clean_path.split("/")
        ancestors = ["/".join(parts[:index]) for index in range(1, len(parts))]
        if any(parent in link_paths for parent in ancestors):
            findings.append(Finding("symlink-parent", "error", entry.path, "Entry descends through a symlink; extraction behavior may escape or overwrite another path."))
        elif any(parent in path_kinds and path_kinds[parent] != "directory" for parent in ancestors):
            findings.append(Finding("path-parent-conflict", "error", entry.path, "A parent entry is not a directory, so this path cannot be materialized consistently."))

    has_errors = any(finding.severity == "error" for finding in findings)
    has_warnings = any(finding.severity == "warning" for finding in findings)
    assessment = "blocked" if incomplete or has_errors else "review" if has_warnings else "no-obvious-risk"
    return {
        "archive": path.name,
        "format": archive_format,
        "entries_scanned": len(entries),
        "declared_bytes_scanned": sum(entry.size for entry in entries),
        "incomplete": incomplete,
        "findings": [asdict(finding) for finding in findings],
        "assessment": assessment,
    }


def _demo_report() -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="archive-glass-") as directory:
        sample = Path(directory) / "weekend.zip"
        with zipfile.ZipFile(sample, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("photos/sunrise.txt", "sample metadata only")
            archive.writestr("../outside.txt", "this path escapes")
        return scan_archive(sample)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Audit ZIP and uncompressed TAR metadata without extracting files.")
    parser.add_argument("archive", type=Path, nargs="?")
    parser.add_argument("--demo", action="store_true", help="scan a tiny synthetic archive and print its report")
    parser.add_argument("--max-entries", type=int, default=DEFAULT_MAX_ENTRIES)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    args = parser.parse_args(argv)
    if args.demo == (args.archive is not None):
        parser.error("provide one archive path or --demo")
    try:
        report = _demo_report() if args.demo else scan_archive(args.archive, args.max_entries, args.max_bytes)
    except (OSError, tarfile.TarError, zipfile.BadZipFile, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 1 if report["assessment"] != "no-obvious-risk" else 0


if __name__ == "__main__":
    raise SystemExit(main())
