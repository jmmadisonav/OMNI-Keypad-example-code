import json
import shutil
import tempfile
import unittest
from pathlib import Path

from designer.models import DEFAULT_MODEL, MODELS_DIR, load_models

DIAL_KEYS = ("ledring", "dial", "dial_button")


class ShippedModelTests(unittest.TestCase):
    def setUp(self):
        self.models = load_models()

    def test_three_models_in_order(self):
        self.assertEqual(list(self.models), ["OMNI-KP-6B", "OMNI-KP-6BV", "OMNI-KP-8BV"])
        self.assertEqual(DEFAULT_MODEL, "OMNI-KP-8BV")

    def test_buttons_dial_faceplate_and_tested(self):
        expected = {"OMNI-KP-6B": ("6B", 2, 3, False, "portrait", False),
                    "OMNI-KP-6BV": ("6BV", 2, 3, True, "portrait", False),
                    "OMNI-KP-8BV": ("8BV", 4, 2, True, "square", True)}
        for model_id, (name, columns, rows, dial, faceplate, tested) in expected.items():
            model = self.models[model_id]
            with self.subTest(model=model_id):
                self.assertEqual((model.name, model.columns, model.rows, model.dial,
                                  model.faceplate, model.tested),
                                 (name, columns, rows, dial, faceplate, tested))
                page = model.template["pages"][0]
                self.assertEqual(len(model.template["pages"]), 1)
                self.assertEqual(len(page["buttons"]), model.buttons)
                self.assertEqual(all(key in page for key in DIAL_KEYS), dial)
                self.assertEqual(any(key in page for key in DIAL_KEYS), dial)
                for button in page["buttons"]:
                    self.assertEqual((button["offImage"], button["onImage"], button["destination"]),
                                     ([], [], ""))

    def test_summary_has_no_template(self):
        summary = self.models["OMNI-KP-6BV"].summary()
        self.assertNotIn("template", summary)
        self.assertEqual(summary["id"], "OMNI-KP-6BV")


class BadModelTests(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp()) / "models"
        shutil.copytree(MODELS_DIR, self.folder)
        self.path = self.folder / "OMNI-KP-6BV.json"
        self.data = json.loads(self.path.read_text(encoding="utf-8"))

    def write(self, data):
        self.path.write_text(json.dumps(data), encoding="utf-8")

    def test_bad_files_are_refused_with_their_name(self):
        cases = {
            "button count": {**self.data, "columns": 4},
            "dial flag": {**self.data, "dial": False},
            "missing field": {k: v for k, v in self.data.items() if k != "rows"},
            "id": {**self.data, "id": "OMNI-KP-9X"},
            "faceplate": {**self.data, "faceplate": "round"},
        }
        for case, data in cases.items():
            with self.subTest(case=case):
                self.write(data)
                with self.assertRaisesRegex(ValueError, "OMNI-KP-6BV.json"):
                    load_models(self.folder)

    def test_invalid_json_is_refused_with_its_name(self):
        self.path.write_text("{ nope", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "OMNI-KP-6BV.json"):
            load_models(self.folder)


if __name__ == "__main__":
    unittest.main()
