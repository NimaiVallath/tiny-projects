# Archive Glass

**Inspect an archive’s risky paths and links before it ever reaches an extractor.**

Archive Glass is a read-only command-line preflight for ZIP and uncompressed TAR files. It looks for traversal paths, absolute paths, duplicate normalized names, links that escape the archive root, entries nested below links, conflicting file/parent paths, special files, suspicious ZIP expansion ratios, and scans stopped by resource budgets.

It never extracts regular-file contents. Its result is a triage signal—not a proof that an archive is safe.

## Run it

Requires Python 3.9 or later and only the standard library:

```bash
python3 projects/011-archive-glass/archive_glass.py path/to/upload.zip
python3 projects/011-archive-glass/archive_glass.py path/to/package.tar
```

Try the built-in synthetic example:

```bash
python3 projects/011-archive-glass/archive_glass.py --demo
```

The demo deliberately includes `../outside.txt`. Archive Glass returns JSON and exit code `1` for blocked or review-required archives, and `0` only when it finds no obvious issue. `--max-entries` and `--max-bytes` lower or raise the metadata scan budgets; an incomplete scan is always blocked.

## Example result

The checked-in [`demo.json`](examples/demo.json) is the deterministic output for the built-in example. Its `blocked` assessment comes from the traversal path; nothing was extracted.

## Design choices

- Paths are normalized across slash styles before checks, so `folder\\..\\file` and `file` collide as the same archive path.
- Symlink targets are resolved relative to the link’s parent; TAR hard-link targets are resolved from the archive root. Entries below a symlink are blocked because extraction behavior can vary between tools.
- ZIP regular-file payloads are never decompressed. A bounded symlink payload is read only to inspect its target. TAR is accepted only in uncompressed random-access mode, so scanning can seek over payload bytes rather than inflate an attacker-controlled stream.
- Duplicate paths, traversal, invalid links, and file/parent conflicts block. Special files, encrypted entries, and suspicious compression ratios require review. Reaching a scan budget marks the report incomplete and blocked.

## Limits

Archive Glass does not extract, sanitize, repair, or certify an archive. It does not inspect file contents, malware, Unicode normalization collisions across filesystems, permissions, ownership, or every extractor’s platform-specific behavior. ZIP libraries parse the central directory before the entry cap can be applied, and malformed input may still exercise parser resource limits. A `no-obvious-risk` result is not a guarantee; use a sandboxed extractor and defense-in-depth for untrusted uploads. Compressed TAR formats are intentionally unsupported.

## Checks

```bash
python3 projects/011-archive-glass/test_archive_glass.py
python3 scripts/check.py
```
