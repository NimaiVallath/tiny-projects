#!/usr/bin/env python3
"""Audit text/background color pairs and suggest minimal accessible repairs."""

from __future__ import annotations

import argparse
import colorsys
import html
import json
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


def _pair_card(pair: dict[str, Any], index: int) -> str:
    role = html.escape(pair["role"])
    foreground_name = html.escape(pair["foreground"])
    background_name = html.escape(pair["background"])
    foreground = pair["foreground_hex"]
    background = pair["background_hex"]
    size_label = "large text" if pair["size"] == "large" else "normal text"
    status_class = "pass" if pair["passes_aa"] else "repair"
    status_text = pair["grade"] if pair["passes_aa"] else "Needs repair"
    repair = pair["repair"]
    repair_panel = ""
    if repair:
        repair_panel = f"""
          <div class="repair-note">
            <div>
              <span class="label">Suggested foreground</span>
              <strong>{repair['hex']}</strong>
              <small>{repair['direction']} by {repair['lightness_shift']} HSL points</small>
            </div>
            <div class="mini-sample" style="color:{repair['hex']};background:{background}">
              Revised sample <b>{repair['ratio']}:1</b>
            </div>
          </div>"""

    return f"""<article class="pair-card" aria-labelledby="pair-{index}-title">
        <div class="pair-heading">
          <div><span class="index">{index + 1:02d}</span><h3 id="pair-{index}-title">{role}</h3></div>
          <span class="badge {status_class}">{status_text}</span>
        </div>
        <div class="sample" style="color:{foreground};background:{background}" aria-label="Original color sample, contrast ratio {pair['ratio']} to 1">
          <span>Clarity belongs in the system.</span>
          <small>{foreground_name} on {background_name}</small>
        </div>
        <div class="ratio-row">
          <div><span class="label">Contrast</span><strong>{pair['ratio']}:1</strong></div>
          <div><span class="label">Target</span><strong>{pair['aa_threshold']}:1</strong></div>
          <div><span class="label">Context</span><strong>{size_label}</strong></div>
        </div>{repair_panel}
      </article>"""


def render_html(report: dict[str, Any], source_name: str = "palette.json") -> str:
    """Render a self-contained, script-free accessibility report."""
    summary = report["summary"]
    percent = round(summary["passing"] / summary["pairs"] * 100)
    swatches = "\n".join(
        f"""<li><span class="swatch" style="background:{item['hex']}" aria-hidden="true"></span>
            <span>{html.escape(item['name'])}<small>{item['hex']}</small></span></li>"""
        for item in report["colors"]
    )
    cards = "\n".join(_pair_card(pair, index) for index, pair in enumerate(report["pairs"]))
    title = html.escape(report["title"])
    source = html.escape(source_name)
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Contrast Compass — {title}</title>
  <style>
    :root {{ --ink:#172033; --muted:#667085; --paper:#f7f4ed; --card:#fffdf8; --line:#d8d2c5; --indigo:#4c4dde; --mint:#d9f7e8; --mint-ink:#17603b; --rose:#ffe0dc; --rose-ink:#8f2f2a; }}
    * {{ box-sizing:border-box; }}
    body {{ margin:0; color:var(--ink); background:var(--paper); font:16px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif; }}
    body::before {{ content:""; position:absolute; inset:0 0 auto; height:28rem; pointer-events:none; background:linear-gradient(135deg,#dfe3ff 0%,#f7f4ed 58%); z-index:-1; }}
    main {{ width:min(1160px,calc(100% - 2rem)); margin:auto; padding:4.5rem 0; }}
    .eyebrow,.label,.index {{ font-size:.73rem; font-weight:750; letter-spacing:.1em; text-transform:uppercase; }}
    .eyebrow {{ color:var(--indigo); margin:0 0 1rem; }} h1,h2,h3,p {{ margin-top:0; }}
    h1 {{ max-width:850px; margin-bottom:1.25rem; font:700 clamp(3.3rem,8vw,7rem)/.87 Georgia,serif; letter-spacing:-.06em; }}
    .lede {{ max-width:730px; color:#4c5569; font-size:1.1rem; }}
    .hero {{ display:grid; grid-template-columns:1fr auto; gap:3rem; align-items:end; border-bottom:1px solid var(--line); padding-bottom:3rem; }}
    .score {{ width:10rem; height:10rem; border-radius:50%; display:grid; place-content:center; text-align:center; background:conic-gradient(var(--indigo) {percent}%,#d8d8e6 0); position:relative; }}
    .score::after {{ content:""; position:absolute; inset:1rem; border-radius:50%; background:var(--paper); }} .score * {{ position:relative; z-index:1; }}
    .score strong {{ font:700 2rem/1 Georgia,serif; }} .score span {{ color:var(--muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.08em; }}
    .summary {{ display:grid; grid-template-columns:repeat(3,1fr); border:1px solid var(--line); background:var(--card); margin:2rem 0 4.5rem; }}
    .summary div {{ padding:1.3rem; border-right:1px solid var(--line); }} .summary div:last-child {{ border:0; }} .summary strong {{ display:block; font-size:1.8rem; }} .summary span {{ color:var(--muted); }}
    section > h2 {{ font:700 2rem/1.1 Georgia,serif; }} .section-note {{ color:var(--muted); max-width:680px; }}
    .palette {{ list-style:none; padding:0; display:grid; grid-template-columns:repeat(6,1fr); gap:.75rem; margin:1.5rem 0 4.5rem; }}
    .palette li {{ display:flex; gap:.65rem; align-items:center; min-width:0; }} .palette small {{ display:block; color:var(--muted); font:700 .72rem ui-monospace,SFMono-Regular,monospace; }}
    .swatch {{ width:2.6rem; height:2.6rem; flex:0 0 auto; border:1px solid #0002; border-radius:50%; }}
    .pairs {{ display:grid; grid-template-columns:1fr 1fr; gap:1rem; }} .pair-card {{ background:var(--card); border:1px solid var(--line); padding:1.25rem; }}
    .pair-heading,.pair-heading > div,.ratio-row,.repair-note {{ display:flex; align-items:center; }} .pair-heading {{ justify-content:space-between; gap:1rem; }} .pair-heading > div {{ gap:.75rem; }}
    h3 {{ margin:0; font-size:1rem; }} .index {{ color:var(--muted); }} .badge {{ padding:.28rem .55rem; border-radius:100px; font-size:.72rem; font-weight:800; white-space:nowrap; }}
    .badge.pass {{ color:var(--mint-ink); background:var(--mint); }} .badge.repair {{ color:var(--rose-ink); background:var(--rose); }}
    .sample {{ min-height:9rem; margin:1.25rem 0; padding:1.2rem; display:flex; flex-direction:column; justify-content:space-between; border:1px solid #0002; }} .sample span {{ font:700 1.55rem/1.1 Georgia,serif; }} .sample small {{ font-weight:750; }}
    .ratio-row {{ gap:1rem; justify-content:space-between; }} .ratio-row > div {{ min-width:0; }} .label {{ display:block; color:var(--muted); margin-bottom:.2rem; }} .ratio-row strong {{ font-size:.9rem; }}
    .repair-note {{ justify-content:space-between; gap:1rem; margin-top:1.2rem; padding-top:1.2rem; border-top:1px solid var(--line); }} .repair-note small {{ display:block; color:var(--muted); }}
    .mini-sample {{ padding:.8rem; border:1px solid #0002; font-size:.78rem; }} .mini-sample b {{ display:block; }}
    .method {{ display:grid; grid-template-columns:repeat(3,1fr); gap:1rem; margin-top:1.5rem; }} .method article {{ border-top:2px solid var(--indigo); padding-top:1rem; }} .method p,footer {{ color:var(--muted); }}
    footer {{ display:flex; justify-content:space-between; gap:1rem; margin-top:4.5rem; padding-top:1.25rem; border-top:1px solid var(--line); font-size:.75rem; }}
    @media (max-width:800px) {{ main{{padding:2.5rem 0}} .hero{{grid-template-columns:1fr}} .score{{width:8rem;height:8rem}} .palette{{grid-template-columns:repeat(2,1fr)}} .pairs{{grid-template-columns:1fr}} .method{{grid-template-columns:1fr}} }}
    @media print {{ body::before{{display:none}} .pair-card{{break-inside:avoid}} }}
  </style>
</head>
<body>
  <main>
    <header class="hero">
      <div><p class="eyebrow">Accessibility field report / {source}</p><h1>Contrast<br>Compass</h1><p class="lede">A map of which palette pairings are ready for readable text—and the smallest hue-preserving lightness shifts for those that are not.</p></div>
      <div class="score" aria-label="{percent} percent of tested pairs pass"><strong>{percent}%</strong><span>AA ready</span></div>
    </header>
    <div class="summary" aria-label="Audit summary"><div><strong>{summary['pairs']}</strong><span>pairings tested</span></div><div><strong>{summary['passing']}</strong><span>already pass</span></div><div><strong>{summary['needing_repair']}</strong><span>adjustments proposed</span></div></div>
    <section aria-labelledby="palette-heading"><h2 id="palette-heading">{title}</h2><p class="section-note">The source palette stays intact. Repairs change only the foreground lightness of a specific pairing.</p><ul class="palette">{swatches}</ul></section>
    <section aria-labelledby="pairs-heading"><h2 id="pairs-heading">Pairing audit</h2><p class="section-note">Each declared use is measured against its WCAG 2.2 AA text threshold. Status is always written as text, never communicated by color alone.</p><div class="pairs">{cards}</div></section>
    <section aria-labelledby="method-heading" style="margin-top:4.5rem"><h2 id="method-heading">How repairs are chosen</h2><div class="method"><article><span class="index">01 / measure</span><p>Convert sRGB channels to relative luminance, then compare the lighter and darker colors.</p></article><article><span class="index">02 / preserve</span><p>Keep foreground hue and saturation fixed while searching all 256 discrete HSL lightness levels.</p></article><article><span class="index">03 / minimize</span><p>Choose the passing color with the smallest lightness shift and verify the rounded hex value again.</p></article></div></section>
    <footer><span>Generated by Contrast Compass</span><span>Self-contained · script-free · no telemetry</span></footer>
  </main>
</body>
</html>\n"""


def _output_path_is_safe(input_path: Path, output_path: Path) -> bool:
    return input_path.resolve() != output_path.resolve()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Audit text/background color pairs against WCAG contrast thresholds."
    )
    parser.add_argument("input", type=Path, help="palette JSON file")
    output_group = parser.add_mutually_exclusive_group()
    output_group.add_argument("--json", type=Path, help="write structured results")
    output_group.add_argument("--html", type=Path, help="write a standalone visual report")
    args = parser.parse_args(argv)

    try:
        output_path = args.json or args.html
        if output_path and not _output_path_is_safe(args.input, output_path):
            raise ValueError("input and output paths must differ")
        report = analyze_palette(parse_palette(args.input.read_text(encoding="utf-8")))
        if output_path:
            rendered = (
                json.dumps(report, indent=2) + "\n"
                if args.json
                else render_html(report, args.input.name)
            )
            output_path.write_text(rendered, encoding="utf-8")
            print(
                f"Audited {report['summary']['pairs']} pairs; "
                f"{report['summary']['needing_repair']} need repair"
            )
        else:
            sys.stdout.write(json.dumps(report, indent=2) + "\n")
        return 0
    except (OSError, ValueError) as error:
        print(f"Contrast Compass: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
