import tempfile
import unittest
import zipfile
from pathlib import Path

from designer.assets import ZIP_PATH, GraphicsZip


def make_zip(names: list[str]) -> Path:
    path = Path(tempfile.mkdtemp()) / "graphics.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("Keypad Graphics/", b"")
        for name in names:
            archive.writestr(f"Keypad Graphics/{name}", name.encode())
    return path


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.zip = GraphicsZip(make_zip([
            "Squared/Squared_Aqua_OFF.png",
            "Squared/Squared_Aqua_ON.png",
            "Squared/Squared_Black.png",
            "Squared/Squared_OFF.png",
            "Squared/Squared_ON.png",
            "Squared/Squared_Magenta_OFF.png",
            "Squared/Squared_Megenta_ON.png",
            "Circle 45/Circle45_DkGrey.png",
            "HDMI_Squared_OFF.png",
            "HDMI_Squared_ON.png",
            "notes.txt",
        ]))

    def test_shapes_pair_off_and_on(self):
        shapes = self.zip.catalog()["shapes"]
        self.assertEqual(shapes["Squared"]["Aqua"], {
            "off": "Squared/Squared_Aqua_OFF.png", "on": "Squared/Squared_Aqua_ON.png"})

    def test_single_file_colour_is_used_for_both_states(self):
        shapes = self.zip.catalog()["shapes"]
        self.assertEqual(shapes["Squared"]["Black"], {
            "off": "Squared/Squared_Black.png", "on": "Squared/Squared_Black.png"})
        self.assertEqual(shapes["Circle 45"]["DkGrey"]["on"], "Circle 45/Circle45_DkGrey.png")

    def test_file_with_no_colour_is_default(self):
        self.assertEqual(self.zip.catalog()["shapes"]["Squared"]["Default"]["off"],
                         "Squared/Squared_OFF.png")

    def test_misspelled_megenta_joins_magenta(self):
        magenta = self.zip.catalog()["shapes"]["Squared"]["Magenta"]
        self.assertEqual(magenta["on"], "Squared/Squared_Megenta_ON.png")
        self.assertNotIn("Megenta", self.zip.catalog()["shapes"]["Squared"])

    def test_root_pairs_are_ready_made_buttons(self):
        self.assertEqual(self.zip.catalog()["buttons"], {"HDMI_Squared": {
            "off": "HDMI_Squared_OFF.png", "on": "HDMI_Squared_ON.png"}})

    def test_read_returns_member_bytes(self):
        self.assertEqual(self.zip.read("Squared/Squared_Black.png"), b"Squared/Squared_Black.png")

    def test_read_rejects_unknown_and_non_png_names(self):
        for name in ("Squared/Nope.png", "notes.txt", "../keypad.json"):
            with self.subTest(name=name), self.assertRaises(KeyError):
                self.zip.read(name)


class RealZipTests(unittest.TestCase):
    def test_real_zip_has_three_shape_sets(self):
        catalog = GraphicsZip(ZIP_PATH).catalog()
        self.assertEqual(sorted(catalog["shapes"]), ["Bubble", "Circle 45", "Squared"])
        self.assertIn("HDMI_Squared", catalog["buttons"])
        for colours in catalog["shapes"].values():
            for files in colours.values():
                self.assertTrue(files["off"] and files["on"])


if __name__ == "__main__":
    unittest.main()
