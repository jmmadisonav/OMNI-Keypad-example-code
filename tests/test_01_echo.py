import importlib
import json
import threading
import time
import unittest

from tests.fake_keypad import default_params
from tests.helpers import KeypadTestCase, wait_until

echo = importlib.import_module("01_buttons_dial_feedback")


def ring_writes(keypad):
    """Return the value of every `set` the keypad received for page 1's ring."""
    return [json.loads(line.split(" ", 1)[1])["value"] for line in list(keypad.received)
            if line.startswith("set ") and "/page1/ledring/level" in line]


class EchoAppTests(KeypadTestCase):
    def setUp(self):
        super().setUp()
        self.app = echo.EchoApp(self.kp, resend=True)
        self.app.start()
        self.addCleanup(self.app.stop)

    def test_reads_page_names(self):
        self.assertEqual(self.app.pages, ["Page 1", "Page 2"])
        self.assertEqual(self.app.current_page, "Page 1")

    def test_button_push_toggles_state(self):
        self.keypad.press("/page2/button4/action", "PUSH")
        self.assertTrue(wait_until(lambda: self.keypad.value("/page2/button4/state") == "ON"))
        self.keypad.press("/page2/button4/action", "RELEASE")
        self.keypad.press("/page2/button4/action", "PUSH")
        self.assertTrue(wait_until(lambda: self.keypad.value("/page2/button4/state") == "OFF"))

    def test_dial_turn_moves_led_ring(self):
        self.keypad.press("/page1/dial/level", -40)
        self.assertTrue(wait_until(lambda: self.keypad.value("/page1/ledring/level") == -40))

    def test_dial_writes_every_event_then_resends(self):
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

    def test_dial_push_goes_to_next_page_and_wraps(self):
        self.keypad.press("/page1/dial_button/action", "PUSH")
        self.assertTrue(wait_until(lambda: self.app.current_page == "Page 2"))
        self.keypad.press("/page1/dial_button/action", "RELEASE")
        self.keypad.press("/page2/dial_button/action", "PUSH")
        self.assertTrue(wait_until(lambda: self.app.current_page == "Page 1"))

    def test_page_change_on_keypad_is_tracked(self):
        self.keypad.press("/settings/currentpage", "Page 2")
        self.assertTrue(wait_until(lambda: self.app.current_page == "Page 2"))


class EchoAppBoundButtonTests(KeypadTestCase):
    # Button 5 on page 1 is bound to OMNI, so the keypad doesn't expose it.
    params = {k: v for k, v in default_params().items() if not k.startswith("/page1/button5/")}

    def test_bound_button_is_reported_and_skipped(self):
        echo.EchoApp(self.kp).start()
        self.assertIn("/page1/button5/action isn't available", self.output.getvalue())


class ReconnectTests(KeypadTestCase):
    def test_run_resubscribes_after_keypad_drops_connection(self):
        stop = threading.Event()
        thread = threading.Thread(
            target=echo.run, args=("127.0.0.1", self.keypad.port, stop, 0.1), daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(stop.set)

        def page_subscriptions():
            return sum('subscribe {"path":"/settings/currentpage"' in line
                       for line in self.keypad.received)

        self.assertTrue(wait_until(lambda: page_subscriptions() == 1))
        self.keypad.disconnect_all()
        self.assertTrue(wait_until(lambda: page_subscriptions() == 2, timeout=3))
        self.assertIn("Connection lost.", self.output.getvalue())


class ErrorReplyTests(KeypadTestCase):
    # Without a model, the first request in start() gets an error reply.
    params = {k: v for k, v in default_params().items()
              if k != "/configuration/device/model"}

    def test_run_retries_after_an_error_reply(self):
        stop = threading.Event()
        thread = threading.Thread(
            target=echo.run, args=("127.0.0.1", self.keypad.port, stop, 0.1), daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(stop.set)
        self.assertTrue(wait_until(
            lambda: self.output.getvalue().count("Can't talk to") >= 2, timeout=3))
        stop.set()
        thread.join(2)
        self.assertFalse(thread.is_alive())


class DoesNotResendByDefaultTests(KeypadTestCase):
    def test_does_not_resend_by_default(self):
        app = echo.EchoApp(self.kp)
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


if __name__ == "__main__":
    unittest.main()
