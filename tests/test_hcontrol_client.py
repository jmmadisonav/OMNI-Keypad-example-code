import os
import threading
import time
import unittest

from hcontrol import HControlClient, HControlError, decode, encode
from tests.helpers import KeypadTestCase, wait_until


class EncodingTests(unittest.TestCase):
    def test_encode_is_compact_json_with_newline(self):
        self.assertEqual(encode("get", {"path": "/a", "format": "string"}),
                         b'get {"path":"/a","format":"string"}\n')

    def test_encode_without_params(self):
        self.assertEqual(encode("unsubscribe"), b"unsubscribe\n")

    def test_decode_splits_command_and_body(self):
        self.assertEqual(decode('@set {"path":"/a","value":1}'), ("@set", {"path": "/a", "value": 1}))
        self.assertEqual(decode("@exec"), ("@exec", None))


class RequestTests(KeypadTestCase):
    def test_get_returns_value(self):
        self.assertEqual(self.kp.get("/configuration/device/model"), "OMNI-KP-8BV")

    def test_get_enum_as_string_or_index(self):
        self.assertEqual(self.kp.get("/settings/currentpage", fmt="string"), "Page 1")
        self.assertEqual(self.kp.get("/settings/currentpage"), 0)

    def test_set_returns_applied_value(self):
        self.assertEqual(self.kp.set("/page1/button1/state", "ON", fmt="string"), "ON")
        self.assertEqual(self.keypad.value("/page1/button1/state"), "ON")

    def test_set_returns_clamped_value(self):
        self.assertEqual(self.kp.set("/page1/ledring/level", 50), 10)

    def test_unknown_path_raises_hcontrol_error(self):
        with self.assertRaises(HControlError) as caught:
            self.kp.get("/nonexistent")
        self.assertEqual(caught.exception.path, "/nonexistent")
        self.assertEqual(caught.exception.message, "unknown path")

    def test_object_get_raises(self):
        with self.assertRaisesRegex(HControlError, "bad param value"):
            self.kp.get("/page1")

    def test_exec_known_command(self):
        self.assertEqual(self.kp.exec("/configuration/commands", "reset", level="System"), {})
        self.assertIn('"arguments":{"level":"System"}', self.keypad.received[-1])

    def test_unanswered_request_times_out(self):
        self.keypad.ignore.add("get")
        start = time.monotonic()
        with self.assertRaises(TimeoutError):
            self.kp.get("/settings/brightness")
        self.assertLess(time.monotonic() - start, 2.0)

    def test_request_after_keypad_disconnects_raises_connection_error(self):
        self.assertTrue(wait_until(lambda: len(self.keypad.sessions) == 1))
        self.keypad.disconnect_all()
        self.assertTrue(wait_until(lambda: not self.kp.connected))
        with self.assertRaises(ConnectionError):
            self.kp.get("/settings/brightness")

    def test_requests_from_many_threads_stay_in_lockstep(self):
        errors = []

        def worker(n):
            try:
                for _ in range(20):
                    self.assertEqual(self.kp.set("/settings/brightness", n), n)
            except Exception as exc:     # pragma: no cover - reported below
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(n,)) for n in (10, 20, 30)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])

    def test_late_reply_after_timeout_is_not_returned_to_the_next_request(self):
        kp = HControlClient("127.0.0.1", self.keypad.port, timeout=0.3)
        self.addCleanup(kp.close)
        self.keypad.delay["get"] = 0.6
        with self.assertRaises(TimeoutError):
            kp.get("/settings/brightness")
        del self.keypad.delay["get"]
        time.sleep(0.5)
        self.keypad.params["/settings/brightness"]["value"] = 77
        self.assertEqual(kp.get("/settings/brightness"), 77)


class SubscriptionTests(KeypadTestCase):
    def setUp(self):
        super().setUp()
        self.events = []

    def record(self, path, value):
        self.events.append((path, value))

    def test_subscribe_returns_current_value(self):
        self.assertEqual(self.kp.subscribe("/settings/currentpage", self.record, fmt="string"), "Page 1")

    def test_publish_reaches_callback_and_is_acknowledged(self):
        self.kp.subscribe("/page1/button1/action", self.record, fmt="string")
        self.keypad.press("/page1/button1/action", "PUSH")
        self.keypad.press("/page1/button1/action", "RELEASE")
        # The second publish only arrives if the first was acknowledged.
        self.assertTrue(wait_until(lambda: len(self.events) == 2))
        self.assertEqual(self.events, [("/page1/button1/action", "PUSH"),
                                       ("/page1/button1/action", "RELEASE")])

    def test_publish_before_set_reply_is_delivered(self):
        self.kp.subscribe("/page1/dial/level", self.record)
        self.assertEqual(self.kp.set("/page1/dial/level", -50), -50)
        self.assertTrue(wait_until(lambda: self.events == [("/page1/dial/level", -50)]))

    def test_callback_can_make_requests(self):
        done = threading.Event()

        def on_push(path, value):
            self.kp.set("/page1/button1/state", "ON", fmt="string")
            done.set()

        self.kp.subscribe("/page1/button1/action", on_push, fmt="string")
        self.keypad.press("/page1/button1/action", "PUSH")
        self.assertTrue(done.wait(2), "callback deadlocked")
        self.assertEqual(self.keypad.value("/page1/button1/state"), "ON")

    def test_failing_callback_does_not_stop_events(self):
        def broken(path, value):
            raise RuntimeError("boom")

        self.kp.subscribe("/page1/button1/action", broken, fmt="string")
        self.kp.subscribe("/page1/button2/action", self.record, fmt="string")
        with self.assertLogs("hcontrol", level="ERROR"):
            self.keypad.press("/page1/button1/action", "PUSH")
            self.keypad.press("/page1/button2/action", "PUSH")
            self.assertTrue(wait_until(lambda: len(self.events) == 1))

    def test_subscribe_to_unknown_path_raises_and_keeps_no_callback(self):
        with self.assertRaises(HControlError):
            self.kp.subscribe("/page1/button9/action", self.record)
        self.assertEqual(self.kp._callbacks, {})

    def test_unsubscribe_one_path(self):
        self.kp.subscribe("/page1/button1/action", self.record, fmt="string")
        self.kp.unsubscribe("/page1/button1/action")
        self.keypad.press("/page1/button1/action", "PUSH")
        time.sleep(0.2)
        self.assertEqual(self.events, [])

    def test_unsubscribe_all(self):
        self.kp.subscribe("/page1/button1/action", self.record, fmt="string")
        self.kp.subscribe("/page1/button2/action", self.record, fmt="string")
        self.kp.unsubscribe()
        self.keypad.press("/page1/button1/action", "PUSH")
        time.sleep(0.2)
        self.assertEqual(self.events, [])

    def test_on_disconnect_called_when_keypad_drops(self):
        dropped = threading.Event()
        kp = HControlClient("127.0.0.1", self.keypad.port, on_disconnect=dropped.set)
        self.addCleanup(kp.close)
        self.assertTrue(wait_until(lambda: len(self.keypad.sessions) == 2))
        self.keypad.disconnect_all()
        self.assertTrue(dropped.wait(2))

    def test_on_disconnect_not_called_on_close(self):
        dropped = threading.Event()
        kp = HControlClient("127.0.0.1", self.keypad.port, on_disconnect=dropped.set)
        kp.close()
        self.assertFalse(dropped.wait(0.3))

    def test_close_from_on_disconnect_is_safe(self):
        errors = []
        done = threading.Event()

        def on_disconnect():
            try:
                kp.close()
            except Exception as e:
                errors.append(e)
            done.set()

        kp = HControlClient("127.0.0.1", self.keypad.port, on_disconnect=on_disconnect)
        self.addCleanup(kp.close)
        self.assertTrue(wait_until(lambda: len(self.keypad.sessions) == 2))
        self.keypad.disconnect_all()
        self.assertTrue(done.wait(2))
        self.assertEqual(errors, [])


class FileTransferTests(KeypadTestCase):
    def test_get_file_reassembles_blocks(self):
        data = os.urandom(5000)      # 6668 base64 chars = 7 blocks
        self.keypad.files["descriptor/hornet.json"] = data
        self.assertEqual(self.kp.get_file("descriptor/hornet.json"), data)

    def test_get_file_of_exact_block_multiple(self):
        data = os.urandom(750)       # exactly one 1000-char block
        self.keypad.files["x"] = data
        self.assertEqual(self.kp.get_file("x"), data)

    def test_get_missing_file_raises(self):
        with self.assertRaisesRegex(HControlError, "file not found"):
            self.kp.get_file("/nope")

    def test_put_file_uploads_with_checksum(self):
        data = os.urandom(4209)
        self.kp.put_file("/project/project.cpio", data)
        self.assertEqual(self.keypad.files["/project/project.cpio"], data)
        self.assertEqual(sum(1 for line in self.keypad.received if line.startswith("block ")), 6)

    def test_put_empty_file(self):
        self.kp.put_file("/project/empty", b"")
        self.assertEqual(self.keypad.files["/project/empty"], b"")

    def test_publish_during_transfer_is_still_delivered(self):
        events = []
        self.kp.subscribe("/page1/button1/action", lambda p, v: events.append(v), fmt="string")
        self.keypad.files["big"] = os.urandom(20000)
        self.keypad.press("/page1/button1/action", "PUSH")
        self.assertEqual(len(self.kp.get_file("big")), 20000)
        self.assertTrue(wait_until(lambda: events == ["PUSH"]))

    def test_requests_still_work_after_transfer(self):
        self.keypad.files["x"] = b"hello"
        self.kp.get_file("x")
        self.assertEqual(self.kp.get("/settings/brightness"), 50)


if __name__ == "__main__":
    unittest.main()
