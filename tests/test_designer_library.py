import base64
import tempfile
import unittest
from pathlib import Path

from designer.library import Library, validate_name
from tests.helpers import make_png

RECIPE = {"version": 1, "name": "", "layers": [{"type": "shape", "set": "Squared",
                                                 "colour": "Blue", "visible": True}]}


class NameTests(unittest.TestCase):
    def test_accepts_letters_digits_spaces_dashes_underscores(self):
        self.assertEqual(validate_name("HDMI 1_main-room"), "HDMI 1_main-room")

    def test_rejects_unsafe_names(self):
        for name in ("", " lead", "trail ", "../x", "a/b", "a\\b", "x.json", "CON", "nul",
                     "a" * 65):
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_name(name)


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp()) / "library"
        self.library = Library(self.folder)

    def test_save_then_get_round_trips_and_sets_name(self):
        self.library.save("HDMI 1", dict(RECIPE), make_png())
        recipe = self.library.get("HDMI 1")
        self.assertEqual(recipe["name"], "HDMI 1")
        self.assertEqual(recipe["layers"], RECIPE["layers"])
        self.assertTrue((self.folder / "HDMI 1.png").exists())

    def test_list_is_sorted_with_thumbnails(self):
        self.library.save("b", dict(RECIPE), make_png(seed=2))
        self.library.save("A", dict(RECIPE), make_png(seed=1))
        items = self.library.list()
        self.assertEqual([i["name"] for i in items], ["A", "b"])
        prefix = "data:image/png;base64,"
        self.assertTrue(items[0]["thumbnail"].startswith(prefix))
        self.assertEqual(base64.b64decode(items[0]["thumbnail"][len(prefix):]), make_png(seed=1))

    def test_save_overwrites_existing(self):
        self.library.save("x", dict(RECIPE), make_png())
        self.library.save("x", {"version": 1, "layers": []}, make_png())
        self.assertEqual(self.library.get("x")["layers"], [])

    def test_delete_removes_both_files(self):
        self.library.save("x", dict(RECIPE), make_png())
        self.library.delete("x")
        self.assertEqual(list(self.folder.iterdir()), [])
        with self.assertRaises(FileNotFoundError):
            self.library.get("x")

    def test_missing_recipe_raises_file_not_found(self):
        with self.assertRaises(FileNotFoundError):
            self.library.get("nope")
        with self.assertRaises(FileNotFoundError):
            self.library.delete("nope")

    def test_save_rejects_bad_recipe_and_thumbnail(self):
        with self.assertRaises(ValueError):
            self.library.save("x", {"version": 2, "layers": []}, make_png())
        with self.assertRaises(ValueError):
            self.library.save("x", {"version": 1, "layers": "no"}, make_png())
        with self.assertRaises(ValueError):
            self.library.save("x", dict(RECIPE), b"not a png")

    def test_unsafe_name_never_touches_the_filesystem(self):
        with self.assertRaises(ValueError):
            self.library.get("../secret")


if __name__ == "__main__":
    unittest.main()
