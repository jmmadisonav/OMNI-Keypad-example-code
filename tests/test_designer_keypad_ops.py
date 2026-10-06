import base64
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from designer import keypad_ops
from designer.keypad_ops import (BusyError, ButtonImages, ConflictError, DeployTimeout,
                                 KeypadOps, apply_buttons, file_base)
from keypad_design import DESIGN_PATH, Design
from tests.fake_keypad import FakeKeypad
from tests.helpers import FIXTURES, make_png


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def original() -> Design:
    return Design.from_cpio((FIXTURES / "original_design.cpio").read_bytes())


class ButtonImagesTests(unittest.TestCase):
    def test_from_json_decodes_and_validates(self):
        item = ButtonImages.from_json({"page": 1, "button": 2, "name": "HDMI 1",
                                       "off": b64(make_png(seed=1)), "on": b64(make_png(seed=2))})
        self.assertEqual((item.page, item.button, item.name), (1, 2, "HDMI 1"))
        self.assertEqual(item.on, make_png(seed=2))

    def test_from_json_rejects_wrong_size(self):
        with self.assertRaisesRegex(ValueError, r"page 1 button 2: the ON image is 200x188"):
            ButtonImages.from_json({"page": 1, "button": 2, "name": "",
                                    "off": b64(make_png()), "on": b64(make_png(200, 188))})

    def test_from_json_rejects_non_png_and_bad_base64(self):
        for value in (b64(b"hello"), "***"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ButtonImages.from_json({"page": 1, "button": 1, "name": "",
                                        "off": value, "on": b64(make_png())})


class NamingTests(unittest.TestCase):
    def test_file_base_uses_recipe_name_or_position(self):
        self.assertEqual(file_base("HDMI 1", 1, 2), "HDMI_1")
        self.assertEqual(file_base("", 2, 7), "p2b7")
        self.assertEqual(file_base("Mic/Mute é", 1, 1), "Mic_Mute__")

    def test_apply_sets_images_and_prunes_unused(self):
        design = original()
        old = design.button(1, 1)["offImage"][0]
        apply_buttons(design, [ButtonImages(1, 1, "HDMI 1", make_png(seed=1), make_png(seed=2))])
        self.assertEqual(design.button(1, 1)["offImage"], ["HDMI_1_OFF.png"])
        self.assertEqual(design.button(1, 1)["onImage"], ["HDMI_1_ON.png"])
        self.assertEqual(design.images["HDMI_1_ON.png"], make_png(seed=2))
        if old not in design.referenced_images():
            self.assertNotIn(old, design.images)
        self.assertEqual(design.missing_images(), [])

    def test_same_recipe_on_two_buttons_shares_images(self):
        design = original()
        pair = (make_png(seed=1), make_png(seed=2))
        apply_buttons(design, [ButtonImages(1, 1, "Mute", *pair), ButtonImages(1, 2, "Mute", *pair)])
        self.assertEqual(design.button(1, 2)["offImage"], ["Mute_OFF.png"])
        self.assertEqual([n for n in design.images if n.startswith("Mute")],
                         ["Mute_OFF.png", "Mute_ON.png"])

    def test_name_collision_with_different_bytes_adds_suffix(self):
        design = original()
        apply_buttons(design, [ButtonImages(1, 1, "HDMI 1", make_png(seed=1), make_png(seed=2))])
        apply_buttons(design, [ButtonImages(1, 2, "HDMI_1", make_png(seed=3), make_png(seed=4))])
        self.assertEqual(design.images["HDMI_1_OFF.png"], make_png(seed=1))
        name = design.button(1, 2)["offImage"][0]
        self.assertRegex(name, r"^HDMI_1_OFF_[0-9a-f]{6}\.png$")
        self.assertEqual(design.images[name], make_png(seed=3))

    def test_redeploying_a_changed_recipe_reuses_its_name(self):
        design = original()
        apply_buttons(design, [ButtonImages(1, 1, "HDMI 1", make_png(seed=1), make_png(seed=2))])
        apply_buttons(design, [ButtonImages(1, 1, "HDMI 1", make_png(seed=5), make_png(seed=6))])
        self.assertEqual(design.button(1, 1)["offImage"], ["HDMI_1_OFF.png"])
        self.assertEqual(design.images["HDMI_1_OFF.png"], make_png(seed=5))

    def test_apply_rejects_missing_button(self):
        with self.assertRaises(IndexError):
            apply_buttons(original(), [ButtonImages(1, 9, "", make_png(), make_png())])


class KeypadOpsTests(unittest.TestCase):
    def setUp(self):
        self.keypad = FakeKeypad().__enter__()
        self.addCleanup(self.keypad.__exit__, None, None, None)
        self.data = (FIXTURES / "original_design.cpio").read_bytes()
        self.keypad.files[DESIGN_PATH] = self.data
        self.backups = Path(tempfile.mkdtemp())
        self.ops = KeypadOps(self.backups, port=self.keypad.port, timeout=2)
        patcher = mock.patch.object(keypad_ops.designs, "wait_for_design")
        self.wait = patcher.start()
        self.addCleanup(patcher.stop)

    def test_load_returns_design_and_saves_a_copy(self):
        result = self.ops.load("127.0.0.1")
        self.assertEqual(result["fingerprint"], original().fingerprint)
        self.assertEqual(len(result["config"]["pages"]), 2)
        name = original().button(1, 1)["offImage"][0]
        self.assertEqual(base64.b64decode(result["images"][name]), original().images[name])
        copies = list(self.backups.glob("loaded_*.cpio"))
        self.assertEqual([c.read_bytes() for c in copies], [self.data])

    def test_load_from_keypad_without_design_times_out_with_message(self):
        self.keypad.ignore.add("getfile")
        self.ops.timeout = 0.5
        with self.assertRaisesRegex(TimeoutError, "no design loaded"):
            self.ops.load("127.0.0.1")

    def test_deploy_backs_up_uploads_and_returns_new_fingerprint(self):
        fingerprint = original().fingerprint
        result = self.ops.deploy("127.0.0.1", fingerprint, [
            ButtonImages(1, 3, "HDMI 1", make_png(seed=1), make_png(seed=2))])
        uploaded = Design.from_cpio(self.keypad.files[DESIGN_PATH])
        self.assertEqual(uploaded.button(1, 3)["offImage"], ["HDMI_1_OFF.png"])
        self.assertEqual(result["fingerprint"], uploaded.fingerprint)
        self.assertNotEqual(result["fingerprint"], fingerprint)
        self.assertEqual((self.backups / result["backup"]).read_bytes(), self.data)
        self.wait.assert_called_once_with("127.0.0.1", self.keypad.port, uploaded.fingerprint)

    def test_deploy_refuses_when_fingerprint_changed(self):
        with self.assertRaises(ConflictError):
            self.ops.deploy("127.0.0.1", "f" * 32, [
                ButtonImages(1, 1, "", make_png(), make_png())])
        self.assertEqual(self.keypad.files[DESIGN_PATH], self.data)

    def test_force_deploys_over_a_changed_design(self):
        self.ops.deploy("127.0.0.1", "f" * 32, [ButtonImages(1, 1, "", make_png(), make_png())],
                        force=True)
        self.assertNotEqual(self.keypad.files[DESIGN_PATH], self.data)

    def test_deploy_timeout_reports_the_backup(self):
        self.wait.side_effect = TimeoutError("didn't restart")
        with self.assertRaises(DeployTimeout) as caught:
            self.ops.deploy("127.0.0.1", original().fingerprint, [
                ButtonImages(1, 1, "", make_png(), make_png())])
        self.assertTrue((self.backups / caught.exception.backup).exists())

    def test_second_deploy_while_first_runs_is_refused(self):
        started, release = threading.Event(), threading.Event()
        self.wait.side_effect = lambda *args: (started.set(), release.wait(5))
        buttons = [ButtonImages(1, 1, "", make_png(), make_png())]
        first = threading.Thread(target=self.ops.deploy,
                                 args=("127.0.0.1", original().fingerprint, buttons))
        first.start()
        self.assertTrue(started.wait(5))
        with self.assertRaises(BusyError):
            self.ops.deploy("127.0.0.1", original().fingerprint, buttons, force=True)
        release.set()
        first.join(5)

    def test_restore_uploads_backup_without_backing_up(self):
        result = self.ops.deploy("127.0.0.1", original().fingerprint, [
            ButtonImages(1, 1, "", make_png(), make_png())])
        before = set(self.backups.iterdir())
        self.ops.restore("127.0.0.1", result["backup"])
        self.assertEqual(self.keypad.files[DESIGN_PATH], self.data)
        self.assertEqual(set(self.backups.iterdir()), before)

    def test_restore_rejects_unsafe_names(self):
        for name in ("../original_design.cpio", "x.cpio", "backup_1.cpio"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.ops.restore("127.0.0.1", name)

    def test_backups_lists_newest_first(self):
        (self.backups / "backup_20260101_000000.cpio").write_bytes(b"")
        (self.backups / "loaded_20260102_000000.cpio").write_bytes(b"")
        self.assertEqual(self.ops.backups(),
                         ["loaded_20260102_000000.cpio", "backup_20260101_000000.cpio"])


if __name__ == "__main__":
    unittest.main()
