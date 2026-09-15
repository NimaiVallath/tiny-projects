#!/usr/bin/env python3
"""Validate the catalog and run every project's dependency-free tests."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def validate_catalog() -> list[Path]:
    catalog_path = ROOT / "projects" / "catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    errors: list[str] = []
    seen_ids: set[int] = set()
    seen_slugs: set[str] = set()
    project_paths: list[Path] = []

    for item in catalog:
        missing = {
            "id", "slug", "title", "date", "summary", "path", "stack", "status"
        } - item.keys()
        if missing:
            errors.append(f"catalog entry is missing: {', '.join(sorted(missing))}")
            continue
        if item["id"] in seen_ids:
            errors.append(f"duplicate project id: {item['id']}")
        if item["slug"] in seen_slugs:
            errors.append(f"duplicate project slug: {item['slug']}")
        seen_ids.add(item["id"])
        seen_slugs.add(item["slug"])

        expected_name = f"{item['id']:03d}-{item['slug']}"
        project_path = ROOT / item["path"]
        project_paths.append(project_path)
        if project_path.name != expected_name:
            errors.append(f"project {item['id']} should use directory {expected_name}")
        if not (project_path / "README.md").is_file():
            errors.append(f"project {item['id']} is missing README.md")
        if item["status"] != "complete":
            errors.append(f"project {item['id']} is not marked complete")

    if errors:
        raise SystemExit("Catalog validation failed:\n- " + "\n- ".join(errors))

    print(f"Catalog: {len(catalog)} complete project(s)")
    return project_paths


def run_tests(project_paths: list[Path]) -> None:
    test_files = []
    for project_path in project_paths:
        files = sorted(project_path.glob("test_*.py")) + sorted(project_path.glob("test_*.mjs"))
        if not files:
            raise SystemExit(f"No project tests were found in {project_path.relative_to(ROOT)}")
        test_files.extend(files)

    for test_file in test_files:
        relative = test_file.relative_to(ROOT)
        print(f"Running {relative}", flush=True)
        command = [sys.executable, str(test_file)] if test_file.suffix == ".py" else ["node", "--test", str(test_file)]
        result = subprocess.run(command, cwd=ROOT, check=False)
        if result.returncode:
            raise SystemExit(result.returncode)

    print(f"Tests: {len(test_files)} test file(s) passed")


if __name__ == "__main__":
    projects = validate_catalog()
    run_tests(projects)
