import unittest
from pathlib import Path

from keypad_design import Design

ROOT = Path(__file__).parent.parent


class ShippedDesignTests(unittest.TestCase):
    def check_third_party(self, design):
        for page in design.pages:
            for control in [page["ledring"], page["dial"], page["dial_button"], *page["buttons"]]:
                self.assertEqual(control["remote"], "")
                self.assertEqual(control["path"], "")
        self.assertEqual(design.missing_images(), [])

    def test_design_is_third_party(self):
        self.check_third_party(Design.load(ROOT / "design"))

    def test_no_borders_design_is_third_party(self):
        self.check_third_party(Design.load(ROOT / "design_no_borders"))

    def test_no_borders_design_hides_separators(self):
        design = Design.load(ROOT / "design_no_borders")
        separator = design.config["display"]["panel_separator_color"]
        for page in design.pages:
            self.assertEqual(separator.lower(), page["background"].lower())

    def test_no_borders_design_differs_only_in_separator_color(self):
        plain = Design.load(ROOT / "design")
        no_borders = Design.load(ROOT / "design_no_borders")
        plain.config["display"]["panel_separator_color"] = "#000000"
        self.assertEqual(no_borders.config, plain.config)
        self.assertEqual(no_borders.images, plain.images)


if __name__ == "__main__":
    unittest.main()
