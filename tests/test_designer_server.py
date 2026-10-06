import base64
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from unittest import mock

from designer import keypad_ops
from designer.assets import GraphicsZip
from designer.keypad_ops import KeypadOps
from designer.library import Library
from designer.server import make_server
from keypad_design import DESIGN_PATH, Design
from tests.fake_keypad import FakeKeypad
from tests.helpers import FIXTURES, make_png


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.keypad = FakeKeypad().__enter__()
        self.addCleanup(self.keypad.__exit__, None, None, None)
        self.data = (FIXTURES / "original_design.cpio").read_bytes()
        self.keypad.files[DESIGN_PATH] = self.data
        tmp = Path(tempfile.mkdtemp())
        zip_path = tmp / "g.zip"
        with zipfile.ZipFile(zip_path, "w") as archive:
            archive.writestr("Keypad Graphics/Squared/Squared_Black.png", make_png())
            archive.writestr("Keypad Graphics/Circle 45/Circle45_White.png", make_png(seed=7))
        self.ops = KeypadOps(tmp / "backups", port=self.keypad.port, timeout=2)
        self.discover = mock.Mock(return_value=[
            {"ip": "10.0.0.5", "name": "kp", "model": "OMNI-KP-8BV", "version": "1.1.4.0"},
            {"ip": "10.0.0.6", "name": "amp", "model": "BLU-160", "version": "1"}])
        self.server = make_server(0, self.ops, Library(tmp / "library"),
                                  GraphicsZip(zip_path), discover=self.discover)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        patcher = mock.patch.object(keypad_ops.designs, "wait_for_design")
        self.wait = patcher.start()
        self.addCleanup(patcher.stop)

    def request(self, method, path, body=None, raw=None):
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.headers, error.read()

    def json_request(self, method, path, body=None):
        status, _, payload = self.request(method, path, body)
        return status, json.loads(payload)

    def test_index_and_static_files(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn(b"<html", body.lower())

    def test_static_rejects_path_traversal(self):
        for path in ("/static/../server.py", "/static/%2e%2e/server.py", "/vendor/../../README.md"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 404)

    def test_assets_catalog_and_asset(self):
        status, catalog = self.json_request("GET", "/api/assets")
        self.assertEqual(status, 200)
        self.assertIn("Circle 45", catalog["shapes"])
        name = catalog["shapes"]["Circle 45"]["White"]["off"]
        status, headers, body = self.request("GET", "/asset/" + urllib.parse.quote(name))
        self.assertEqual((status, headers["Content-Type"], body), (200, "image/png", make_png(seed=7)))
        self.assertEqual(self.request("GET", "/asset/nope.png")[0], 404)

    def test_keypads_lists_only_omni_keypads(self):
        status, found = self.json_request("GET", "/api/keypads")
        self.assertEqual((status, [d["ip"] for d in found]), (200, ["10.0.0.5"]))

    def test_load_then_deploy(self):
        status, loaded = self.json_request("POST", "/api/design/load", {"host": "127.0.0.1"})
        self.assertEqual(status, 200)
        status, result = self.json_request("POST", "/api/design/deploy", {
            "host": "127.0.0.1", "fingerprint": loaded["fingerprint"], "force": False,
            "buttons": [{"page": 1, "button": 1, "name": "Mute",
                         "off": b64(make_png(seed=1)), "on": b64(make_png(seed=2))}]})
        self.assertEqual(status, 200, result)
        self.assertEqual(Design.from_cpio(self.keypad.files[DESIGN_PATH]).fingerprint,
                         result["fingerprint"])
        status, backups = self.json_request("GET", "/api/backups")
        self.assertIn(result["backup"], backups)

    def test_deploy_with_only_a_layout(self):
        fingerprint = Design.from_cpio(self.data).fingerprint
        status, result = self.json_request("POST", "/api/design/deploy", {
            "host": "127.0.0.1", "fingerprint": fingerprint, "buttons": [],
            "layout": {"pages": [{"name": "Home", "source": 1}, {"name": "Extra", "source": None}],
                       "destinations": [{"page": 1, "button": 8, "destination": "Extra"}]}})
        self.assertEqual(status, 200, result)
        uploaded = Design.from_cpio(self.keypad.files[DESIGN_PATH])
        self.assertEqual([p["name"] for p in uploaded.pages], ["Home", "Extra"])
        self.assertEqual(uploaded.button(1, 8)["destination"], "Extra")

    def test_deploy_with_nothing_to_change_is_400(self):
        status, body = self.json_request("POST", "/api/design/deploy", {
            "host": "127.0.0.1", "fingerprint": "x", "buttons": []})
        self.assertEqual(status, 400)

    def test_deploy_with_bad_layout_is_400(self):
        status, body = self.json_request("POST", "/api/design/deploy", {
            "host": "127.0.0.1", "fingerprint": "x", "force": True, "buttons": [],
            "layout": {"pages": [{"name": "A", "source": 1}, {"name": "A", "source": 2}]}})
        self.assertEqual(status, 400, body)

    def test_deploy_conflict_is_409(self):
        status, body = self.json_request("POST", "/api/design/deploy", {
            "host": "127.0.0.1", "fingerprint": "f" * 32,
            "buttons": [{"page": 1, "button": 1, "name": "",
                         "off": b64(make_png()), "on": b64(make_png())}]})
        self.assertEqual((status, body.get("conflict")), (409, True))

    def test_deploy_bad_image_is_400_and_nothing_uploaded(self):
        status, body = self.json_request("POST", "/api/design/deploy", {
            "host": "127.0.0.1", "fingerprint": "x",
            "buttons": [{"page": 1, "button": 1, "name": "",
                         "off": b64(make_png(100, 100)), "on": b64(make_png())}]})
        self.assertEqual(status, 400)
        self.assertIn("100x100", body["error"])
        self.assertEqual(self.keypad.files[DESIGN_PATH], self.data)

    def test_deploy_timeout_is_504_with_backup(self):
        self.wait.side_effect = TimeoutError("slow")
        fingerprint = Design.from_cpio(self.data).fingerprint
        status, body = self.json_request("POST", "/api/design/deploy", {
            "host": "127.0.0.1", "fingerprint": fingerprint,
            "buttons": [{"page": 1, "button": 1, "name": "",
                         "off": b64(make_png()), "on": b64(make_png())}]})
        self.assertEqual(status, 504)
        self.assertTrue(body["backup"].startswith("backup_"))

    def test_failed_upload_is_502_with_backup(self):
        fingerprint = Design.from_cpio(self.data).fingerprint
        with mock.patch.object(keypad_ops.designs, "upload", side_effect=ConnectionResetError("reset")):
            status, body = self.json_request("POST", "/api/design/deploy", {
                "host": "127.0.0.1", "fingerprint": fingerprint,
                "buttons": [{"page": 1, "button": 1, "name": "",
                             "off": b64(make_png()), "on": b64(make_png())}]})
        self.assertEqual(status, 502)
        self.assertTrue(body["backup"].startswith("backup_"))

    def test_unreachable_keypad_is_502(self):
        self.ops.port = 1
        status, body = self.json_request("POST", "/api/design/load", {"host": "127.0.0.1"})
        self.assertEqual(status, 502)
        self.assertIn("127.0.0.1", body["error"])

    def test_keypad_without_design_is_504(self):
        self.keypad.ignore.add("getfile")
        self.ops.timeout = 0.5
        status, body = self.json_request("POST", "/api/design/load", {"host": "127.0.0.1"})
        self.assertEqual(status, 504)
        self.assertIn("no design loaded", body["error"])

    def test_library_crud(self):
        recipe = {"version": 1, "name": "", "layers": []}
        status, saved = self.json_request("PUT", "/api/library/HDMI%201",
                                          {"recipe": recipe, "thumbnail": b64(make_png())})
        self.assertEqual((status, saved["name"]), (200, "HDMI 1"))
        status, items = self.json_request("GET", "/api/library")
        self.assertEqual([i["name"] for i in items], ["HDMI 1"])
        self.assertEqual(self.json_request("GET", "/api/library/HDMI%201")[1]["name"], "HDMI 1")
        self.assertEqual(self.json_request("DELETE", "/api/library/HDMI%201")[0], 200)
        self.assertEqual(self.json_request("GET", "/api/library/HDMI%201")[0], 404)

    def test_library_rejects_unsafe_name(self):
        status, _ = self.json_request("PUT", "/api/library/..%2Fx",
                                      {"recipe": {"version": 1, "layers": []},
                                       "thumbnail": b64(make_png())})
        self.assertEqual(status, 400)

    def test_writes_without_json_content_type_are_refused(self):
        # A cross-site page can send text/plain without a CORS preflight.
        req = urllib.request.Request(self.base + "/api/design/load", method="POST",
                                     data=json.dumps({"host": "127.0.0.1"}).encode(),
                                     headers={"Content-Type": "text/plain"})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=10)
        with caught.exception:
            self.assertEqual(caught.exception.code, 415)
        self.assertEqual(list(self.ops.backup_dir.glob("loaded_*")), [])

    def test_refused_write_with_large_body_still_gets_a_reply(self):
        # The server must read the body before it answers, or Windows resets
        # the connection and the client never sees the 415.
        req = urllib.request.Request(self.base + "/api/design/deploy", method="POST",
                                     data=b"x" * 2_000_000, headers={"Content-Type": "text/plain"})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=10)
        with caught.exception:
            self.assertEqual(caught.exception.code, 415)

    def test_requests_for_another_host_name_are_refused(self):
        # DNS rebinding: a page on evil.example resolves to 127.0.0.1.
        req = urllib.request.Request(self.base + "/api/assets",
                                     headers={"Host": "evil.example:8044"})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=10)
        with caught.exception:
            self.assertEqual(caught.exception.code, 403)

    def test_localhost_host_name_is_allowed(self):
        port = self.server.server_address[1]
        req = urllib.request.Request(self.base + "/api/assets",
                                     headers={"Host": f"localhost:{port}"})
        with urllib.request.urlopen(req, timeout=10) as response:
            self.assertEqual(response.status, 200)

    def test_programming_errors_are_500_not_400(self):
        with mock.patch.object(self.ops, "backups", side_effect=TypeError("bug")), \
                mock.patch("traceback.print_exc"):
            status, body = self.json_request("GET", "/api/backups")
        self.assertEqual(status, 500)

    def test_missing_or_malformed_fields_are_400(self):
        for body in ({"host": "127.0.0.1", "fingerprint": "x"},
                     {"host": "127.0.0.1", "fingerprint": "x", "buttons": [{"page": 1}]},
                     {"host": "127.0.0.1", "fingerprint": "x", "force": True, "buttons": [
                         {"page": 1, "button": 99, "off": b64(make_png()), "on": b64(make_png())}]}):
            with self.subTest(body=body):
                status, reply = self.json_request("POST", "/api/design/deploy", body)
                self.assertEqual(status, 400, reply)

    def test_bad_json_is_400_and_unknown_route_is_404(self):
        self.assertEqual(self.request("POST", "/api/design/load", raw=b"{nope")[0], 400)
        self.assertEqual(self.request("POST", "/api/design/load", body={})[0], 400)
        self.assertEqual(self.request("GET", "/api/nothing")[0], 404)


if __name__ == "__main__":
    unittest.main()
