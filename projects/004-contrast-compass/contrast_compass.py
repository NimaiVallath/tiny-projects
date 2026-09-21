#!/usr/bin/env python3
"""Audit text/background color pairs and suggest minimal accessible repairs."""

from __future__ import annotations

import argparse
import colorsys
import json
import math
import re
import sys
from pathlib import Path
from typing import Any


HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")
AA_THRESHOLDS = {"normal": 4.5, "large": 3.0}
AAA_THRESHOLDS = {"normal": 7.0, "large": 4.5}


def parse_hex(value: str) -> tuple[int, int, int]:
    """Return an RGB tuple for a six-digit CSS hex color."""
    if not isinstance(value, str) or not HEX_COLOR.fullmatch(value):
        raise ValueError(f"invalid color {value!r}; expected #RRGGBB")
    return tuple(int(value[index : index + 2], 16) for index in (1, 3, 5))


def rgb_to_hex(rgb: tuple[int, int, int]) -> str:
    return "#" + "".join(f"{channel:02X}" for channel in rgb)


def relative_luminance(color: str) -> float:
    """Calculate WCAG relative luminance for an sRGB hex color."""

    def linearize(channel: int) -> float:
        value = channel / 255
        return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4

    red, green, blue = (linearize(channel) for channel in parse_hex(color))
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_ratio(foreground: str, background: str) -> float:
    lighter, darker = sorted(
        (relative_luminance(foreground), relative_luminance(background)), reverse=True
    )
    return (lighter + 0.05) / (darker + 0.05)


def parse_palette(text: str) -> dict[str, Any]:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid JSON at line {error.lineno}, column {error.colno}") from error
    if not isinstance(payload, dict):
        raise ValueError("palette must be a JSON object")

    title = payload.get("title")
    if not isinstance(title, str) or not title.strip() or len(title) > 60:
        raise ValueError("title must be 1–60 characters")

    raw_colors = payload.get("colors")
    if not isinstance(raw_colors, list) or not 2 <= len(raw_colors) <= 24:
        raise ValueError("colors must contain 2–24 entries")
    colors: list[dict[str, str]] = []
    names: set[str] = set()
    for index, item in enumerate(raw_colors, 1):
        if not isinstance(item, dict):
            raise ValueError(f"color {index} must be an object")
        name = item.get("name")
        value = item.get("hex")
        if not isinstance(name, str) or not name.strip() or len(name) > 32:
            raise ValueError(f"color {index} name must be 1–32 characters")
        if name in names:
            raise ValueError(f"duplicate color name: {name}")
        parse_hex(value)
        names.add(name)
        colors.append({"name": name, "hex": value.upper()})

    raw_pairs = payload.get("pairs")
    if not isinstance(raw_pairs, list) or not 1 <= len(raw_pairs) <= 48:
        raise ValueError("pairs must contain 1–48 entries")
    pairs: list[dict[str, str]] = []
    for index, item in enumerate(raw_pairs, 1):
        if not isinstance(item, dict):
            raise ValueError(f"pair {index} must be an object")
        role = item.get("role")
        foreground = item.get("foreground")
        background = item.get("background")
        size = item.get("size")
        if not isinstance(role, str) or not role.strip() or len(role) > 48:
            raise ValueError(f"pair {index} role must be 1–48 characters")
        if foreground not in names:
            raise ValueError(f"pair {index} references unknown foreground: {foreground}")
        if background not in names:
            raise ValueError(f"pair {index} references unknown background: {background}")
        if foreground == background:
            raise ValueError(f"pair {index} must use two different colors")
        if size not in AA_THRESHOLDS:
            raise ValueError(f"pair {index} size must be normal or large")
        pairs.append(
            {
                "role": role,
                "foreground": foreground,
                "background": background,
                "size": size,
            }
        )

    return {"title": title.strip(), "colors": colors, "pairs": pairs}


def _color_at_lightness(hue: float, saturation: float, lightness: float) -> str:
    channels = colorsys.hls_to_rgb(hue, lightness, saturation)
    return rgb_to_hex(tuple(round(channel * 255) for channel in channels))


def find_repair(foreground: str, background: str, threshold: float) -> dict[str, Any] | None:
    """Find the smallest 8-bit HSL lightness shift that reaches the threshold."""
    original_ratio = contrast_ratio(foreground, background)
    if original_ratio >= threshold:
        return None

    red, green, blue = (channel / 255 for channel in parse_hex(foreground))
    hue, original_lightness, saturation = colorsys.rgb_to_hls(red, green, blue)
    candidates: list[tuple[float, float, str, float]] = []
    for step in range(256):
        lightness = step / 255
        candidate = _color_at_lightness(hue, saturation, lightness)
        ratio = contrast_ratio(candidate, background)
        if ratio + 1e-12 >= threshold:
            candidates.append((abs(lightness - original_lightness), -ratio, candidate, lightness))

    if not candidates:
        raise ValueError(f"no foreground repair can reach {threshold}:1")
    distance, negative_ratio, candidate, lightness = min(candidates)
    return {
        "hex": candidate,
        "ratio": round(-negative_ratio, 2),
        "direction": "lighter" if lightness > original_lightness else "darker",
        "lightness_shift": round(distance * 100, 1),
    }


def analyze_palette(palette: dict[str, Any]) -> dict[str, Any]:
    colors = {item["name"]: item["hex"] for item in palette["colors"]}
    results = []
    for pair in palette["pairs"]:
        foreground = colors[pair["foreground"]]
        background = colors[pair["background"]]
        ratio = contrast_ratio(foreground, background)
        aa_threshold = AA_THRESHOLDS[pair["size"]]
        aaa_threshold = AAA_THRESHOLDS[pair["size"]]
        passes_aa = ratio + 1e-12 >= aa_threshold
        results.append(
            {
                **pair,
                "foreground_hex": foreground,
                "background_hex": background,
                "ratio": round(ratio, 2),
                "aa_threshold": aa_threshold,
                "grade": "AAA" if ratio >= aaa_threshold else "AA" if passes_aa else "Repair",
                "passes_aa": passes_aa,
                "repair": None if passes_aa else find_repair(foreground, background, aa_threshold),
            }
        )

    passing = sum(result["passes_aa"] for result in results)
    return {
        "title": palette["title"],
        "summary": {
            "pairs": len(results),
            "passing": passing,
            "needing_repair": len(results) - passing,
        },
        "colors": palette["colors"],
        "pairs": results,
    }


def _output_path_is_safe(input_path: Path, output_path: Path) -> bool:
    return input_path.resolve() != output_path.resolve()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Audit text/background color pairs against WCAG contrast thresholds."
    )
    parser.add_argument("input", type=Path, help="palette JSON file")
    parser.add_argument("--json", type=Path, help="write structured results instead of printing them")
    args = parser.parse_args(argv)

    try:
        if args.json and not _output_path_is_safe(args.input, args.json):
            raise ValueError("input and output paths must differ")
        report = analyze_palette(parse_palette(args.input.read_text(encoding="utf-8")))
        rendered = json.dumps(report, indent=2) + "\n"
        if args.json:
            args.json.write_text(rendered, encoding="utf-8")
            print(
                f"Audited {report['summary']['pairs']} pairs; "
                f"{report['summary']['needing_repair']} need repair"
            )
        else:
            sys.stdout.write(rendered)
        return 0
    except (OSError, ValueError) as error:
        print(f"Contrast Compass: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
