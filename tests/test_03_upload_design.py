import importlib
import os
import tempfile
import unittest
from pathlib import Path

from keypad_design import DESIGN_PATH, Design
from tests.helpers import FIXTURES, KeypadTestCase

designs = importlib.import_module("03_upload_design")


class UploadDesignTests(KeypadTestCase):
    def setUp(self):
        super().setUp()
        self.original = (FIXTURES / "original_design.cpio").read_bytes()
        self.keypad.files[DESIGN_PATH] = self.original
        self.tmp = Path(tempfile.mkdtemp())

    def test_backup_writes_cpio_and_folder(self):
        target = designs.backup(self.kp, self.tmp / "b.cpio")
        self.assertEqual(target.read_bytes(), self.original)
        self.assertTrue((self.tmp / "b" / "keypad.json").exists())

    def test_upload_sends_design(self):
        data = Design.from_cpio(self.original).to_cpio()
        designs.upload(self.kp, data)
        self.assertEqual(self.keypad.files[DESIGN_PATH], data)

    def test_wait_for_design_returns_when_fingerprint_matches(self):
        self.keypad.params["/configuration/device/fingerprint"]["value"] = "a" * 32
        designs.wait_for_design("127.0.0.1", self.keypad.port, "a" * 32, timeout=3)
        self.assertIn("running the new design", self.output.getvalue())

    def test_wait_for_design_times_out_if_keypad_never_switches(self):
        with self.assertRaises(TimeoutError):
            designs.wait_for_design("127.0.0.1", self.keypad.port, "f" * 32, timeout=1)

    def test_wait_for_design_retries_while_keypad_is_down(self):
        with self.assertRaises(TimeoutError):
            designs.wait_for_design("127.0.0.1", 1, "f" * 32, timeout=1)   # Port 1: refused.

    def test_deploy_backs_up_uploads_and_waits(self):
        design = Design.from_cpio(self.original)
        data = design.to_cpio()
        # The fake keypad doesn't redeploy, so make it report the new fingerprint.
        self.keypad.params["/configuration/device/fingerprint"]["value"] = design.fingerprint
        cwd = Path.cwd()
        os.chdir(self.tmp)                 # backup() writes to the current folder.
        self.addCleanup(os.chdir, cwd)
        backup = designs.deploy("127.0.0.1", self.keypad.port, data=data)
        self.assertEqual(self.keypad.files[DESIGN_PATH], data)
        backups = list(self.tmp.glob("backup_*.cpio"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backup.resolve(), backups[0].resolve())
        self.assertEqual(backups[0].read_bytes(), self.original)

    def test_backup_timeout_suggests_no_backup(self):
        # After a factory reset, the keypad never answers getfile for the design.
        self.keypad.ignore.add("getfile")
        with self.assertRaisesRegex(TimeoutError, "--no-backup"):
            designs.backup(self.kp, self.tmp / "b.cpio")

    def test_deploy_without_backup_uploads_to_a_reset_keypad(self):
        self.keypad.ignore.add("getfile")
        del self.keypad.files[DESIGN_PATH]
        design = Design.from_cpio(self.original)
        data = design.to_cpio()
        self.keypad.params["/configuration/device/fingerprint"]["value"] = design.fingerprint
        cwd = Path.cwd()
        os.chdir(self.tmp)
        self.addCleanup(os.chdir, cwd)
        backup = designs.deploy("127.0.0.1", self.keypad.port, data=data, backup_first=False)
        self.assertIsNone(backup)
        self.assertEqual(self.keypad.files[DESIGN_PATH], data)
        self.assertEqual(list(self.tmp.glob("backup_*")), [])

    def test_wait_for_design_retries_after_error_replies(self):
        # While it restarts, the keypad can answer with an error instead of a value.
        del self.keypad.params["/configuration/device/fingerprint"]
        with self.assertRaises(TimeoutError):
            designs.wait_for_design("127.0.0.1", self.keypad.port, "f" * 32, timeout=1)


if __name__ == "__main__":
    unittest.main()
