import json
import socket
import threading
import unittest
from pathlib import Path

from hcontrol import decode, discover, encode, find_param, validate, walk_descriptor

from tests.helpers import FIXTURES

ROOT = Path(__file__).parent.parent


def load(name):
    return json.loads(name.read_text(encoding="utf-8"))


class DiscoveryTests(unittest.TestCase):
    def test_discover_collects_replies(self):
        responder = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        responder.bind(("127.0.0.1", 0))
        self.addCleanup(responder.close)
        port = responder.getsockname()[1]
        seen = []

        def answer():
            data, address = responder.recvfrom(65536)
            command, params = decode(data.decode())
            seen.append((command, params))
            reply = {"ip": "127.0.0.1", "model": "OMNI-KP-8BV", "guid": "abc", "version": "1.1.4.0"}
            for _ in range(2):   # Real keypads often answer twice.
                responder.sendto(encode("@disco", reply), ("127.0.0.1", params["replyport"]))

        threading.Thread(target=answer, daemon=True).start()
        found = discover(timeout=0.5, port=port, broadcast="127.0.0.1")
        self.assertEqual(seen[0][0], "disco")
        self.assertIn("model", seen[0][1]["params"])
        self.assertEqual(found, [{"ip": "127.0.0.1", "model": "OMNI-KP-8BV",
                                  "guid": "abc", "version": "1.1.4.0"}])

    def test_discover_with_no_devices_returns_empty_list(self):
        unused = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        unused.bind(("127.0.0.1", 0))
        port = unused.getsockname()[1]
        unused.close()
        self.assertEqual(discover(timeout=0.3, port=port, broadcast="127.0.0.1"), [])


class WalkTests(unittest.TestCase):
    def test_firmware_1_1_paths(self):
        paths = {p.path: p for p in walk_descriptor(load(FIXTURES / "descriptor_fw1_1_4.json"))}
        self.assertEqual(paths["/page1/button1/state"].enums, ("OFF", "Alt", "ON"))
        self.assertEqual(paths["/page2/dial/level"].type, "integer")
        self.assertEqual(paths["/settings/currentpage"].enums, ("Page 1", "Page 2"))
        self.assertIn("/pages/1/name", paths)
        self.assertIn("/pages/2/background", paths)
        self.assertNotIn("/pages/0/name", paths)

    def test_commands_are_listed_with_arguments(self):
        info = find_param(load(FIXTURES / "descriptor_fw1_1_4.json"), "/configuration/commands/reset")
        self.assertEqual(info.kind, "command")
        assert info.arguments is not None
        self.assertEqual(info.arguments["level"][".enums"], ["System", "Factory"])

    def test_array_prototype_is_expanded(self):
        paths = [p.path for p in walk_descriptor(load(FIXTURES / "descriptor_fw1_1_4.json"))]
        self.assertTrue(any(p.startswith("/configuration/network/interface/1/") for p in paths))

    def test_firmware_1_0_paths(self):
        paths = {p.path for p in walk_descriptor(load(ROOT / "docs" / "OMNI_dynamic_keypad.json"))}
        self.assertIn("/pages/1/dial", paths)
        self.assertIn("/pages/7/buttons/8/output", paths)

    def test_find_param_missing_raises_key_error(self):
        with self.assertRaises(KeyError):
            find_param({".kind": "obj"}, "/x")


class ValidateTests(unittest.TestCase):
    desc = load(FIXTURES / "descriptor_fw1_1_4.json")

    def test_accepts_valid_values(self):
        validate(self.desc, "/page1/button1/state", "ON")
        validate(self.desc, "/page1/button1/state", 2)
        validate(self.desc, "/page1/ledring/level", -100)
        validate(self.desc, "/settings/hapticfeedback", True)
        validate(self.desc, "/pages/1/background", "#003366")

    def test_rejects_with_clear_messages(self):
        cases = [
            ("/page1/ledring/level", 50, "above the maximum of 10"),
            ("/page1/ledring/level", -101, "below the minimum of -100"),
            ("/page1/ledring/level", 1.5, "whole number"),
            ("/page1/ledring/level", "5", "needs a number"),
            ("/page1/ledring/level", True, "needs a number"),
            ("/page1/button1/state", "on", "must be one of OFF | Alt | ON"),
            ("/page1/button1/state", 3, "index must be 0 to 2"),
            ("/page1/button1/action", "PUSH", "read-only"),
            ("/settings/hapticfeedback", 1, "true or false"),
            ("/pages/1/background", "#0033669", "at most 7 characters"),
            ("/page9/button1/state", "ON", "isn't in the descriptor"),
            ("/configuration/commands/reset", "System", "is a command"),
        ]
        for path, value, message in cases:
            with self.subTest(path=path, value=value):
                with self.assertRaisesRegex(ValueError, message):
                    validate(self.desc, path, value)


if __name__ == "__main__":
    unittest.main()
