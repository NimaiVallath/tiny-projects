#!/usr/bin/env python3
"""Create deterministic generative SVG artwork from a short piece of text."""

from __future__ import annotations

import argparse
import colorsys
import hashlib
import html
import math
from pathlib import Path


class Entropy:
    """A stable byte stream derived from a seed string."""

    def __init__(self, seed: str) -> None:
        self._seed = seed.encode("utf-8")
        self._buffer = bytearray()
        self._counter = 0

    def take(self, count: int) -> bytes:
        while len(self._buffer) < count:
            block = hashlib.sha256(
                self._seed + b"|" + str(self._counter).encode("ascii")
            ).digest()
            self._buffer.extend(block)
            self._counter += 1
        result = bytes(self._buffer[:count])
        del self._buffer[:count]
        return result

    def unit(self) -> float:
        return int.from_bytes(self.take(4), "big") / 0xFFFFFFFF

    def between(self, low: float, high: float) -> float:
        return low + (high - low) * self.unit()


def hsl_to_hex(hue: float, saturation: float, lightness: float) -> str:
    red, green, blue = colorsys.hls_to_rgb(
        (hue % 360) / 360, lightness / 100, saturation / 100
    )
    return f"#{round(red * 255):02x}{round(green * 255):02x}{round(blue * 255):02x}"


def build_palette(entropy: Entropy) -> list[str]:
    base = entropy.between(0, 360)
    return [
        hsl_to_hex(base, 62, 12),
        hsl_to_hex(base + 28, 70, 24),
        hsl_to_hex(base + 155, 78, 58),
        hsl_to_hex(base + 205, 86, 72),
        hsl_to_hex(base + 42, 92, 82),
    ]


def generate_svg(text: str, width: int = 1200, height: int = 630) -> str:
    if not text.strip():
        raise ValueError("text must not be empty")
    if width < 320 or height < 240:
        raise ValueError("canvas must be at least 320 by 240 pixels")

    entropy = Entropy(text)
    palette = build_palette(entropy)
    safe_text = html.escape(text.strip(), quote=True)

    points: list[tuple[float, float, float]] = []
    for _ in range(18):
        points.append(
            (
                entropy.between(width * 0.08, width * 0.92),
                entropy.between(height * 0.08, height * 0.70),
                entropy.between(1.8, 6.8),
            )
        )

    line_elements = []
    for index, (x1, y1, _) in enumerate(points):
        candidates = [
            (math.hypot(x2 - x1, y2 - y1), x2, y2)
            for x2, y2, _ in points[index + 1 :]
        ]
        for _, x2, y2 in sorted(candidates)[:2]:
            line_elements.append(
                f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" '
                f'y2="{y2:.1f}" />'
            )

    star_elements = []
    for index, (x, y, radius) in enumerate(points):
        color = palette[2 + (index % 3)]
        star_elements.append(
            f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{radius:.1f}" '
            f'fill="{color}" />'
        )
        if radius > 5:
            star_elements.append(
                f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{radius * 2.8:.1f}" '
                f'fill="none" stroke="{color}" stroke-opacity=".22" />'
            )

    wave_elements = []
    for layer in range(4):
        baseline = height * (0.66 + layer * 0.075)
        lift = entropy.between(height * 0.05, height * 0.16)
        midpoint = entropy.between(width * 0.34, width * 0.66)
        wave_elements.append(
            f'<path d="M -40 {baseline:.1f} C {width * .22:.1f} '
            f'{baseline - lift:.1f}, {midpoint:.1f} {baseline + lift:.1f}, '
            f'{width + 40:.1f} {baseline - lift * .35:.1f} L {width + 40} '
            f'{height + 40} L -40 {height + 40} Z" fill="{palette[layer + 1]}" '
            f'fill-opacity="{0.19 + layer * 0.10:.2f}" />'
        )

    orbit_x = entropy.between(width * 0.72, width * 0.88)
    orbit_y = entropy.between(height * 0.18, height * 0.34)
    orbit_radius = entropy.between(height * 0.08, height * 0.16)
    title_size = max(21, min(34, width // 34))
    caption_size = max(13, min(19, width // 64))

    lines = "\n    ".join(line_elements)
    stars = "\n    ".join(star_elements)
    waves = "\n    ".join(wave_elements)
    fingerprint = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]

    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title description">
  <title id="title">Commit Canvas: {safe_text}</title>
  <desc id="description">Deterministic generative artwork created from the phrase {safe_text}.</desc>
  <metadata>commit-canvas:{fingerprint}</metadata>
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{palette[0]}" />
      <stop offset="1" stop-color="{palette[1]}" />
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="{palette[3]}" stop-opacity=".42" />
      <stop offset="1" stop-color="{palette[3]}" stop-opacity="0" />
    </radialGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="18" /></filter>
  </defs>
  <rect width="{width}" height="{height}" rx="24" fill="url(#sky)" />
  <circle cx="{orbit_x:.1f}" cy="{orbit_y:.1f}" r="{orbit_radius * 2.4:.1f}" fill="url(#glow)" filter="url(#soft)" />
  <g fill="none" stroke="{palette[4]}" stroke-opacity=".18" stroke-width="1">
    <ellipse cx="{orbit_x:.1f}" cy="{orbit_y:.1f}" rx="{orbit_radius * 1.75:.1f}" ry="{orbit_radius * .58:.1f}" transform="rotate(-18 {orbit_x:.1f} {orbit_y:.1f})" />
    <circle cx="{orbit_x:.1f}" cy="{orbit_y:.1f}" r="{orbit_radius:.1f}" />
  </g>
  <g stroke="{palette[3]}" stroke-opacity=".19" stroke-width="1">
    {lines}
  </g>
  <g>
    {stars}
  </g>
  <g>
    {waves}
  </g>
  <g transform="translate({width * .07:.1f} {height * .80:.1f})">
    <text fill="{palette[4]}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="{caption_size}" letter-spacing="2">COMMIT CANVAS · {fingerprint.upper()}</text>
    <text y="{title_size * 1.55:.1f}" fill="#ffffff" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="{title_size}" font-weight="650">{safe_text}</text>
  </g>
</svg>
'''


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Turn text into deterministic generative SVG artwork."
    )
    parser.add_argument("text", help="the phrase used as the visual seed")
    parser.add_argument("--output", "-o", type=Path, default=Path("canvas.svg"))
    parser.add_argument("--width", type=int, default=1200)
    parser.add_argument("--height", type=int, default=630)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        generate_svg(args.text, width=args.width, height=args.height),
        encoding="utf-8",
    )
    print(f"Created {args.output}")


if __name__ == "__main__":
    main()
