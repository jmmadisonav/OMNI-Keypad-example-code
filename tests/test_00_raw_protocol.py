import contextlib
import importlib
import io
import json
import sys
import threading
import time
import unittest
from unittest import mock

from tests.fake_keypad import FakeKeypad, default_params
from tests.helpers import wait_until

raw = importlib.import_module("00_raw_protocol")


def ring_writes(keypad):
    """Return the value of every `set` the keypad received for page 1's ring."""
    return [json.loads(line.split(" ", 1)[1])["value"] for line in list(keypad.received)
            if line.startswith("set ") and "/page1/ledring/level" in line]


class RawProtocolTest(unittest.TestCase):
    def setUp(self):
        self.output = io.StringIO()
        redirect = contextlib.redirect_stdout(self.output)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)

    def start(self, params=None, resend=False):
        self.keypad = FakeKeypad(params)
        self.keypad.__enter__()
        self.addCleanup(self.keypad.__exit__, None, None, None)
        self.thread = threading.Thread(
            target=raw.run, args=("127.0.0.1", self.keypad.port), kwargs={"resend": resend}, daemon=True)
        self.thread.start()
        subscribed = wait_until(lambda: any(
            line.startswith('subscribe {"path":"/page2/dial_button/action"')
            for line in self.keypad.received))
        self.assertTrue(subscribed)
        self.assertTrue(wait_until(lambda: "Ready." in self.output.getvalue()))

    def finish(self):
        self.keypad.disconnect_all()
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive())

    def test_trace_shows_sent_and_received_lines(self):
        self.start()
        self.finish()
        text = self.output.getvalue()
        self.assertIn('-> get {"path":"/pages/1/name"}', text)
        self.assertIn('<- @get {"path":"/pages/1/name","value":"Page 1"}', text)
        self.assertIn(
            '-> subscribe {"path":"/page1/button1/action","format":"string"}', text)

    def test_button_push_toggles_state_and_is_acknowledged(self):
        self.start()
        path = "/page1/button3/state"
        self.keypad.press("/page1/button3/action", "PUSH")
        self.assertTrue(wait_until(lambda: self.keypad.value(path) == "ON"))
        self.assertTrue(any(line.startswith("@publish") for line in self.keypad.received))
        self.keypad.press("/page1/button3/action", "RELEASE")
        self.keypad.press("/page1/button3/action", "PUSH")
        self.assertTrue(wait_until(lambda: self.keypad.value(path) == "OFF"))
        self.finish()

    def test_dial_turn_sets_led_ring(self):
        self.start()
        self.keypad.press("/page2/dial/level", -30)
        self.assertTrue(wait_until(
            lambda: self.keypad.value("/page2/ledring/level") == -30))
        self.finish()

    def test_dial_writes_every_event_then_resends(self):
        self.start(resend=True)
        # The fake keypad clamps to the design range, so widen it first.
        self.keypad.params["/page1/dial/level"]["max"] = 100
        self.keypad.params["/page1/ledring/level"]["max"] = 100
        for level in range(10, 90, 10):
            self.keypad.press("/page1/dial/level", level)
        self.assertTrue(wait_until(
            lambda: len(ring_writes(self.keypad)) >= 9, timeout=3))
        writes = ring_writes(self.keypad)
        self.assertEqual(writes[-1], 80)
        self.assertEqual(self.keypad.value("/page1/ledring/level"), 80)
        # The resend comes after the last dial event, so the last two writes match.
        self.assertEqual(writes[-2:], [80, 80])
        self.finish()

    def test_does_not_resend_by_default(self):
        self.start()
        # The fake keypad clamps to the design range, so widen it first.
        self.keypad.params["/page1/dial/level"]["max"] = 100
        self.keypad.params["/page1/ledring/level"]["max"] = 100
        for level in range(10, 90, 10):
            self.keypad.press("/page1/dial/level", level)
        self.assertTrue(wait_until(
            lambda: self.keypad.value("/page1/ledring/level") == 80, timeout=3))
        time.sleep(1.0)    # Longer than the 0.6 s resend window.
        self.assertEqual(len(ring_writes(self.keypad)), 8)
        self.finish()

    def test_main_passes_resend_flag_to_run(self):
        for flags in (["--resend"], ["-r"]):
            with mock.patch.object(sys, "argv", ["00_raw_protocol.py", *flags, "1.2.3.4"]),                     mock.patch.object(raw, "run") as run:
                raw.main()
            run.assert_called_once_with("1.2.3.4", resend=True)
        with mock.patch.object(sys, "argv", ["00_raw_protocol.py", "1.2.3.4"]),                 mock.patch.object(raw, "run") as run:
            raw.main()
        run.assert_called_once_with("1.2.3.4", resend=False)

    def test_dial_push_moves_to_next_page_and_wraps(self):
        self.start()
        self.keypad.press("/page1/dial_button/action", "PUSH")
        self.assertTrue(wait_until(
            lambda: self.keypad.value("/settings/currentpage") == "Page 2"))
        self.keypad.press("/page1/dial_button/action", "RELEASE")
        self.keypad.press("/page1/dial_button/action", "PUSH")
        self.assertTrue(wait_until(
            lambda: self.keypad.value("/settings/currentpage") == "Page 1"))
        self.finish()

    def test_bound_button_is_skipped(self):
        params = {path: value for path, value in default_params().items()
                  if not path.startswith("/page1/button5/")}
        self.start(params)
        self.finish()
        text = self.output.getvalue()
        self.assertIn("(skipping /page1/button5/action: unknown path)", text)
        self.assertIn("Ready.", text)

    def test_run_returns_when_keypad_disconnects(self):
        self.start()
        self.finish()
        self.assertIn("Connection closed by the keypad.", self.output.getvalue())

    def test_main_without_host_prints_usage(self):
        with mock.patch.object(sys, "argv", ["00_raw_protocol.py"]):
            with self.assertRaises(SystemExit) as caught:
                raw.main()
        self.assertEqual(caught.exception.code, 2)
        self.assertIn("Usage:", self.output.getvalue())


if __name__ == "__main__":
    unittest.main()
