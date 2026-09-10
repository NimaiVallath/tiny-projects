#!/usr/bin/env python3

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from commit_canvas import generate_svg, hsl_to_hex


class CommitCanvasTests(unittest.TestCase):
    def test_output_is_deterministic(self) -> None:
        self.assertEqual(generate_svg("an idea"), generate_svg("an idea"))

    def test_different_text_changes_the_art(self) -> None:
        self.assertNotEqual(generate_svg("first"), generate_svg("second"))

    def test_text_is_safely_escaped(self) -> None:
        svg = generate_svg('make <small> things & ship "often"')
        self.assertIn("&lt;small&gt;", svg)
        self.assertIn("&amp;", svg)
        self.assertNotIn("<small>", svg)

    def test_dimensions_are_reflected_in_svg(self) -> None:
        svg = generate_svg("wide", width=800, height=400)
        self.assertIn('width="800" height="400"', svg)
        self.assertIn('viewBox="0 0 800 400"', svg)

    def test_rejects_empty_text_and_tiny_canvas(self) -> None:
        with self.assertRaises(ValueError):
            generate_svg("  ")
        with self.assertRaises(ValueError):
            generate_svg("small", width=100, height=100)

    def test_hsl_conversion_returns_hex_color(self) -> None:
        self.assertRegex(hsl_to_hex(210, 50, 50), r"^#[0-9a-f]{6}$")

    def test_cli_writes_an_svg(self) -> None:
        script = Path(__file__).with_name("commit_canvas.py")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "nested" / "canvas.svg"
            result = subprocess.run(
                [sys.executable, str(script), "cli test", "--output", str(output)],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(output.exists())
            self.assertTrue(output.read_text(encoding="utf-8").startswith("<svg"))


if __name__ == "__main__":
    unittest.main()
