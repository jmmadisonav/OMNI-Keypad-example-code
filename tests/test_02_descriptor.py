import importlib
import json
import tempfile
import time
import unittest
from pathlib import Path

from tests.helpers import FIXTURES, KeypadTestCase, wait_until

descriptor = importlib.import_module("02_descriptor")


def ring_writes(keypad):
    """Return the value of every `set` the keypad received for page 1's ring."""
    return [json.loads(line.split(" ", 1)[1])["value"] for line in list(keypad.received)
            if line.startswith("set ") and "/page1/ledring/level" in line]


class DescriptorTests(KeypadTestCase):
    def setUp(self):
        super().setUp()
        self.desc_bytes = (FIXTURES / "descriptor_fw1_1_4.json").read_bytes()
        self.keypad.files["descriptor/hornet.json"] = self.desc_bytes
        self.tmp = Path(tempfile.mkdtemp())

    def test_download_saves_by_fingerprint(self):
        desc, cache = descriptor.download_descriptor(self.kp, self.tmp)
        self.assertEqual(cache.name, "descriptor_" + "0" * 32 + ".json")
        self.assertEqual(desc, json.loads(self.desc_bytes))

    def test_download_uses_cache_when_fingerprint_matches(self):
        descriptor.download_descriptor(self.kp, self.tmp)
        del self.keypad.files["descriptor/hornet.json"]
        desc, _ = descriptor.download_descriptor(self.kp, self.tmp)   # No getfile needed.
        self.assertIn("settings", desc)

    def test_download_replaces_a_corrupt_cache(self):
        cache = self.tmp / ("descriptor_" + "0" * 32 + ".json")
        cache.write_text('{"truncated', encoding="utf-8")
        desc, path = descriptor.download_descriptor(self.kp, self.tmp)
        self.assertEqual(path, cache)
        self.assertEqual(desc, json.loads(self.desc_bytes))
        self.assertEqual(json.loads(cache.read_text(encoding="utf-8")), desc)
        self.assertFalse(cache.with_suffix(".tmp").exists())

    def test_format_table_filters_and_shows_ranges(self):
        table = descriptor.format_table(json.loads(self.desc_bytes), "page1/ledring")
        lines = table.splitlines()
        self.assertTrue(lines[0].startswith("PATH"))
        self.assertTrue(any("/page1/ledring/level" in l and "-100..10" in l for l in lines))
        self.assertTrue(any("NORMAL | MODE1" in l for l in lines))
        self.assertFalse(any("/page2/" in l for l in lines))

    def test_format_table_shows_command_arguments(self):
        table = descriptor.format_table(json.loads(self.desc_bytes), "commands")
        self.assertIn("level: System|Factory (optional)", table)

    def test_descriptor_app_subscribes_and_responds(self):
        app = descriptor.DescriptorApp(self.kp, json.loads(self.desc_bytes))
        app.start()
        self.assertIn("/page2/dial_button/action", app.event_paths())
        self.assertIn("/settings/currentpage", app.event_paths())
        self.keypad.press("/page1/button2/action", "PUSH")
        self.assertTrue(wait_until(lambda: self.keypad.value("/page1/button2/state") == "ON"))
        self.keypad.press("/page2/dial/level", 5)
        self.assertTrue(wait_until(lambda: self.keypad.value("/page2/ledring/level") == 5))

    def test_dial_writes_every_event_then_resends(self):
        desc = json.loads(self.desc_bytes)
        desc["page1"]["ledring"]["level"][".max"] = 100
        # The fake keypad clamps to the design range, so widen it first.
        self.keypad.params["/page1/dial/level"]["max"] = 100
        self.keypad.params["/page1/ledring/level"]["max"] = 100
        app = descriptor.DescriptorApp(self.kp, desc, resend=True)
        app.start()
        self.addCleanup(app.stop)
        for level in range(10, 90, 10):
            self.keypad.press("/page1/dial/level", level)
        self.assertTrue(wait_until(
            lambda: len(ring_writes(self.keypad)) >= 9, timeout=3))
        writes = ring_writes(self.keypad)
        self.assertEqual(writes[-1], 80)
        self.assertEqual(self.keypad.value("/page1/ledring/level"), 80)
        # The resend comes after the last dial event, so the last two writes match.
        self.assertEqual(writes[-2:], [80, 80])

    def test_does_not_resend_by_default(self):
        desc = json.loads(self.desc_bytes)
        desc["page1"]["ledring"]["level"][".max"] = 100
        app = descriptor.DescriptorApp(self.kp, desc)
        app.start()
        self.addCleanup(app.stop)
        # The fake keypad clamps to the design range, so widen it first.
        self.keypad.params["/page1/dial/level"]["max"] = 100
        self.keypad.params["/page1/ledring/level"]["max"] = 100
        for level in range(10, 90, 10):
            self.keypad.press("/page1/dial/level", level)
        self.assertTrue(wait_until(
            lambda: self.keypad.value("/page1/ledring/level") == 80, timeout=3))
        time.sleep(1.0)    # Longer than the 0.6 s resend window.
        self.assertEqual(len(ring_writes(self.keypad)), 8)

    def test_descriptor_app_refuses_invalid_value(self):
        desc = json.loads(self.desc_bytes)
        # Shrink the LED ring range in the descriptor so the dial value is out of range.
        desc["page1"]["ledring"]["level"][".max"] = 0
        app = descriptor.DescriptorApp(self.kp, desc)
        app.start()
        self.keypad.press("/page1/dial/level", 5)
        self.assertTrue(wait_until(lambda: "above the maximum of 0" in self.output.getvalue()))
        self.assertEqual(self.keypad.value("/page1/ledring/level"), 0)


if __name__ == "__main__":
    unittest.main()
