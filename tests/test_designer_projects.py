import base64
import datetime
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from designer.keypad_ops import ButtonImages, Layout
from designer.projects import ProjectStore, project_name_for
from keypad_design import Design
from tests.helpers import FIXTURES, make_png

RECIPE = {"version": 1, "name": "", "layers": [{"type": "shape", "set": "Squared",
                                                 "colour": "Blue", "visible": True}]}


def layout(pages, destinations=()):
    return Layout.from_json({
        "pages": [{"name": n, "source": s} for n, s in pages],
        "destinations": [{"page": p, "button": b, "destination": d} for p, b, d in destinations]})


class ProjectStoreTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp()) / "projects"
        self.store = ProjectStore(self.folder)
        self.data = (FIXTURES / "original_design.cpio").read_bytes()

    def test_new_project_has_one_empty_page_from_the_template(self):
        project = self.store.new("Lobby")
        config = project["config"]
        self.assertEqual([p["name"] for p in config["pages"]], ["Page 1"])
        page = config["pages"][0]
        self.assertEqual(len(page["buttons"]), 8)
        self.assertIn("dial", page)
        for button in page["buttons"]:
            self.assertEqual((button["offImage"], button["onImage"], button["destination"]), ([], [], ""))
        self.assertEqual((config["fingerprint"], config["lastdeployedtimestamp"]), ("", ""))
        self.assertEqual((project["images"], project["recipes"], project["baseFingerprint"]), ({}, {}, ""))
        self.assertTrue((self.folder / "Lobby" / "designer.json").exists())

    def test_save_applies_layout_buttons_and_recipes_then_reopens(self):
        self.store.new("Lobby")
        self.store.save("Lobby", [ButtonImages(2, 1, "Mute", make_png(seed=1), make_png(seed=2))],
                        layout([("Main", 1), ("Lights", None)], [(1, 8, "Lights")]),
                        {"2-1": RECIPE})
        project = self.store.open("Lobby")
        self.assertEqual([p["name"] for p in project["config"]["pages"]], ["Main", "Lights"])
        self.assertEqual(project["config"]["pages"][0]["buttons"][7]["destination"], "Lights")
        self.assertEqual(project["config"]["pages"][1]["buttons"][0]["offImage"], ["Mute_OFF.png"])
        self.assertEqual(base64.b64decode(project["images"]["Mute_ON.png"]), make_png(seed=2))
        self.assertEqual(project["recipes"], {"2-1": RECIPE})
        self.assertEqual(sorted(p.name for p in (self.folder / "Lobby" / "images").iterdir()),
                         ["Mute_OFF.png", "Mute_ON.png"])

    def test_save_after_deleting_a_page_renumbers_recipes_and_removes_files(self):
        self.store.new("Lobby")
        self.store.save("Lobby", [ButtonImages(2, 1, "Mute", make_png(seed=1), make_png(seed=2))],
                        layout([("Page 1", 1), ("Page 2", None)]), {"2-1": RECIPE})
        # The page sends recipes in the new numbering: page 2 is gone.
        self.store.save("Lobby", [], layout([("Page 2", 2)]), {"1-1": RECIPE})
        project = self.store.open("Lobby")
        self.assertEqual([p["name"] for p in project["config"]["pages"]], ["Page 2"])
        self.assertEqual(project["recipes"], {"1-1": RECIPE})
        self.store.save("Lobby", [], layout([("Page 1", None)]), {})
        self.assertEqual(list((self.folder / "Lobby" / "images").iterdir()), [])
        self.assertEqual(self.store.open("Lobby")["recipes"], {})

    def test_save_rejects_recipes_for_missing_buttons_or_bad_layers(self):
        self.store.new("Lobby")
        for recipes in ({"2-1": RECIPE}, {"1-9": RECIPE}, {"x": RECIPE},
                        {"1-1": {"version": 2, "layers": []}}, []):
            with self.subTest(recipes=recipes), self.assertRaises(ValueError):
                self.store.save("Lobby", [], None, recipes)

    def test_failed_save_leaves_the_project_intact(self):
        self.store.new("Lobby")
        self.store.save("Lobby", [ButtonImages(1, 1, "A", make_png(seed=1), make_png(seed=2))], None, {})
        with mock.patch.object(Design, "save", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.store.save("Lobby", [ButtonImages(1, 1, "B", make_png(seed=3), make_png(seed=4))],
                                None, {})
        self.assertEqual(self.store.open("Lobby")["config"]["pages"][0]["buttons"][0]["offImage"],
                         ["A_OFF.png"])
        self.assertEqual([p.name for p in self.folder.iterdir()], ["Lobby"])   # No temp folders.

    def test_new_and_copy_refuse_taken_names(self):
        self.store.new("Lobby")
        self.store.new("Hall")
        with self.assertRaises(FileExistsError):
            self.store.new("Lobby")
        with self.assertRaises(FileExistsError):
            self.store.copy("Hall", "Lobby")

    def test_copy_keeps_design_recipes_and_base(self):
        self.store.import_design("Lobby", self.data, "abc")
        self.store.save("Lobby", [], None, {"1-1": RECIPE})
        copy = self.store.copy("Lobby", "Lobby copy")
        self.assertEqual(copy["recipes"], {"1-1": RECIPE})
        self.assertEqual(copy["baseFingerprint"], "abc")
        self.assertEqual(copy["config"]["pages"], self.store.open("Lobby")["config"]["pages"])

    def test_import_keeps_the_keypad_design_and_records_its_fingerprint(self):
        original = Design.from_cpio(self.data)
        project = self.store.import_design("Keypad", self.data, original.fingerprint)
        self.assertEqual([p["name"] for p in project["config"]["pages"]], ["Page 1", "Page 2"])
        self.assertEqual(project["baseFingerprint"], original.fingerprint)
        self.assertEqual(self.store.base_fingerprint("Keypad"), original.fingerprint)
        self.assertEqual(self.store.design("Keypad").missing_images(), [])

    def test_set_base_updates_only_the_fingerprint(self):
        self.store.new("Lobby")
        self.store.save("Lobby", [], None, {"1-1": RECIPE})
        self.store.set_base("Lobby", "f" * 32)
        project = self.store.open("Lobby")
        self.assertEqual((project["baseFingerprint"], project["recipes"]), ("f" * 32, {"1-1": RECIPE}))

    def test_list_is_newest_first_and_skips_other_folders(self):
        self.store.new("Old")
        time.sleep(0.05)
        self.store.new("New")
        (self.folder / ".leftover.tmp").mkdir()
        (self.folder / "not a project").mkdir()
        self.assertEqual([p["name"] for p in self.store.list()], ["New", "Old"])
        self.assertRegex(self.store.list()[0]["saved"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$")

    def test_unique_name_adds_a_number(self):
        self.assertEqual(self.store.unique_name("Lobby"), "Lobby")
        self.store.new("Lobby")
        self.store.new("Lobby 2")
        self.assertEqual(self.store.unique_name("Lobby"), "Lobby 3")

    def test_unsafe_and_missing_names(self):
        with self.assertRaises(ValueError):
            self.store.new("../evil")
        with self.assertRaises(FileNotFoundError):
            self.store.open("Nope")

    def test_project_name_for_host(self):
        self.assertEqual(project_name_for("172.17.0.55", datetime.date(2026, 10, 6)),
                         "172-17-0-55 2026-10-06")
        self.assertEqual(project_name_for("fe80::1", datetime.date(2026, 10, 6)), "fe80--1 2026-10-06")

    def test_saved_project_folder_deploys_with_the_cli_loader(self):
        self.store.new("Lobby")
        self.store.save("Lobby", [ButtonImages(1, 1, "A", make_png(seed=1), make_png(seed=2))], None, {})
        design = Design.load(self.folder / "Lobby")
        self.assertEqual(design.missing_images(), [])
        self.assertNotIn("designer.json", json.dumps(sorted(design.images)))


if __name__ == "__main__":
    unittest.main()
