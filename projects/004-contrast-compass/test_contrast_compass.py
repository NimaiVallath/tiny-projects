import json
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from contrast_compass import (
    analyze_palette,
    contrast_ratio,
    find_repair,
    parse_hex,
    parse_palette,
    relative_luminance,
    render_html,
)


PROJECT = Path(__file__).resolve().parent
SCRIPT = PROJECT / "contrast_compass.py"
SAMPLE = PROJECT / "examples" / "fictional-palette.json"
PREVIEW = PROJECT / "examples" / "report-preview.svg"


class ColorMathTests(unittest.TestCase):
    def test_reference_endpoints_have_expected_luminance_and_contrast(self):
        self.assertEqual(parse_hex("#000000"), (0, 0, 0))
        self.assertEqual(relative_luminance("#000000"), 0)
        self.assertEqual(relative_luminance("#FFFFFF"), 1)
        self.assertEqual(contrast_ratio("#000000", "#FFFFFF"), 21)

    def test_parser_rejects_ambiguous_or_broken_palettes(self):
        with self.assertRaisesRegex(ValueError, "expected #RRGGBB"):
            parse_hex("#fff")
        payload = {
            "title": "Duplicate",
            "colors": [{"name": "Ink", "hex": "#000000"}, {"name": "Ink", "hex": "#FFFFFF"}],
            "pairs": [],
        }
        with self.assertRaisesRegex(ValueError, "duplicate color name"):
            parse_palette(json.dumps(payload))

    def test_repair_is_minimal_in_discrete_lightness_space_and_passes(self):
        repair = find_repair("#A8B3C5", "#F7F2E8", 4.5)
        self.assertIsNotNone(repair)
        self.assertGreaterEqual(contrast_ratio(repair["hex"], "#F7F2E8"), 4.5)
        self.assertEqual(repair["direction"], "darker")


class PaletteTests(unittest.TestCase):
    def test_sample_analysis_reports_passes_and_repairs(self):
        palette = parse_palette(SAMPLE.read_text(encoding="utf-8"))
        report = analyze_palette(palette)
        self.assertEqual(report["summary"]["pairs"], 6)
        self.assertGreater(report["summary"]["passing"], 0)
        self.assertGreater(report["summary"]["needing_repair"], 0)
        for pair in report["pairs"]:
            if pair["repair"]:
                self.assertGreaterEqual(pair["repair"]["ratio"], pair["aa_threshold"])

    def test_cli_prints_json_and_writes_an_explicit_file(self):
        printed = subprocess.run(
            [sys.executable, str(SCRIPT), str(SAMPLE)], capture_output=True, text=True, check=False
        )
        self.assertEqual(printed.returncode, 0, printed.stderr)
        self.assertEqual(json.loads(printed.stdout)["summary"]["pairs"], 6)

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.json"
            written = subprocess.run(
                [sys.executable, str(SCRIPT), str(SAMPLE), "--json", str(output)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(written.returncode, 0, written.stderr)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["title"], "Signal Garden")

    def test_cli_refuses_to_overwrite_input(self):
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "palette.json"
            original = SAMPLE.read_text(encoding="utf-8")
            input_path.write_text(original, encoding="utf-8")
            run = subprocess.run(
                [sys.executable, str(SCRIPT), str(input_path), "--json", str(input_path)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(run.returncode, 1)
            self.assertIn("input and output paths must differ", run.stderr)
            self.assertEqual(input_path.read_text(encoding="utf-8"), original)

    def test_html_report_is_semantic_self_contained_and_escapes_names(self):
        palette = parse_palette(SAMPLE.read_text(encoding="utf-8"))
        palette["title"] = "<Signal & Garden>"
        palette["pairs"][0]["role"] = "Primary <body>"
        rendered = render_html(analyze_palette(palette), "<palette>.json")
        self.assertIn("<!doctype html>", rendered)
        self.assertIn('aria-label="Audit summary"', rendered)
        self.assertIn("&lt;Signal &amp; Garden&gt;", rendered)
        self.assertIn("Primary &lt;body&gt;", rendered)
        self.assertNotIn("<script", rendered)
        self.assertNotIn("https://", rendered)

    def test_cli_writes_standalone_html_report(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.html"
            run = subprocess.run(
                [sys.executable, str(SCRIPT), str(SAMPLE), "--html", str(output)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, run.stderr)
            rendered = output.read_text(encoding="utf-8")
            self.assertIn("Contrast Compass", rendered)
            self.assertIn("#5E6F8C", rendered)
            self.assertIn("<strong>2</strong><span>adjustments proposed", rendered)

    def test_checked_in_preview_is_accessible_and_matches_sample_repairs(self):
        root = ET.parse(PREVIEW).getroot()
        namespace = {"svg": "http://www.w3.org/2000/svg"}
        self.assertEqual(root.attrib["role"], "img")
        self.assertIsNotNone(root.find("svg:title", namespace))
        self.assertIsNotNone(root.find("svg:desc", namespace))
        source = PREVIEW.read_text(encoding="utf-8")
        self.assertIn("#5E6F8C", source)
        self.assertIn("#527664", source)


if __name__ == "__main__":
    unittest.main()
