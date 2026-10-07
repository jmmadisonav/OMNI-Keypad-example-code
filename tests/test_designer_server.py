import base64
import copy
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
from designer.projects import ProjectStore
from designer.server import make_server
from keypad_design import DESIGN_PATH, Design
from tests.fake_keypad import FakeKeypad
from tests.helpers import FIXTURES, make_png


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


RECIPE = {"version": 1, "name": "", "layers": []}


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
        self.projects = ProjectStore(tmp / "projects")
        self.discover = mock.Mock(return_value=[
            {"ip": "10.0.0.5", "name": "kp", "model": "OMNI-KP-8BV", "version": "1.1.4.0"},
            {"ip": "10.0.0.6", "name": "amp", "model": "BLU-160", "version": "1"}])
        self.server = make_server(0, self.ops, Library(tmp / "library"), GraphicsZip(zip_path),
                                  self.projects, discover=self.discover)
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
            with urllib.request.urlopen(req, timeout=20) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.headers, error.read()

    def json_request(self, method, path, body=None):
        status, _, payload = self.request(method, path, body)
        return status, json.loads(payload)

    def from_keypad(self):
        status, project = self.json_request("POST", "/api/projects/from-keypad", {"host": "127.0.0.1"})
        self.assertEqual(status, 200, project)
        return project

    # -- Static files, assets, discovery -------------------------------------------------

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
        name = catalog["shapes"]["Circle 45"]["White"]["off"]
        status, headers, body = self.request("GET", "/asset/" + urllib.parse.quote(name))
        self.assertEqual((status, headers["Content-Type"], body), (200, "image/png", make_png(seed=7)))
        self.assertEqual(self.request("GET", "/asset/nope.png")[0], 404)

    def test_keypads_lists_only_omni_keypads(self):
        status, found = self.json_request("GET", "/api/keypads")
        self.assertEqual((status, [d["ip"] for d in found]), (200, ["10.0.0.5"]))

    # -- Projects ---------------------------------------------------------------------------

    def test_new_open_save_list(self):
        status, project = self.json_request("POST", "/api/projects", {"name": "Lobby"})
        self.assertEqual((status, project["name"]), (200, "Lobby"))
        status, saved = self.json_request("PUT", "/api/projects/Lobby", {
            "buttons": [{"page": 1, "button": 1, "name": "Mute",
                         "off": b64(make_png(seed=1)), "on": b64(make_png(seed=2))}],
            "layout": {"pages": [{"name": "Main", "source": 1}], "destinations": []},
            "recipes": {"1-1": RECIPE}})
        self.assertEqual(status, 200, saved)
        status, opened = self.json_request("GET", "/api/projects/Lobby")
        self.assertEqual(opened["config"]["pages"][0]["name"], "Main")
        self.assertEqual(opened["recipes"], {"1-1": RECIPE})
        self.assertIn("Mute_OFF.png", opened["images"])
        self.assertEqual([p["name"] for p in self.json_request("GET", "/api/projects")[1]], ["Lobby"])

    def test_save_checks_images_against_the_project_model(self):
        self.json_request("POST", "/api/projects", {"name": "Desk", "model": "OMNI-KP-6B"})
        small = {"page": 1, "button": 1, "name": "", "off": b64(make_png(150, 150)),
                 "on": b64(make_png(150, 150, seed=1))}
        large = {**small, "off": b64(make_png()), "on": b64(make_png(seed=1))}
        status, body = self.json_request("PUT", "/api/projects/Desk", {"buttons": [large], "recipes": {}})
        self.assertEqual(status, 400, body)
        self.assertIn("buttons need 150x150", body["error"])
        status, body = self.json_request("PUT", "/api/projects/Desk", {"buttons": [small], "recipes": {}})
        self.assertEqual(status, 200, body)

    def test_taken_project_name_is_409(self):
        self.json_request("POST", "/api/projects", {"name": "Lobby"})
        self.json_request("POST", "/api/projects", {"name": "Hall"})
        self.assertEqual(self.json_request("POST", "/api/projects", {"name": "Lobby"})[0], 409)
        self.assertEqual(self.json_request("POST", "/api/projects/Hall/copy", {"to": "Lobby"})[0], 409)

    def test_copy(self):
        self.json_request("POST", "/api/projects", {"name": "Lobby"})
        status, copy = self.json_request("POST", "/api/projects/Lobby/copy", {"to": "Lobby 2"})
        self.assertEqual((status, copy["name"]), (200, "Lobby 2"))

    def test_bad_names_and_missing_projects(self):
        self.assertEqual(self.json_request("POST", "/api/projects", {"name": "../x"})[0], 400)
        self.assertEqual(self.json_request("GET", "/api/projects/Nope")[0], 404)
        self.assertEqual(self.json_request("PUT", "/api/projects/Nope",
                                           {"buttons": [], "recipes": {}})[0], 404)

    def test_save_rejects_bad_requests(self):
        self.json_request("POST", "/api/projects", {"name": "Lobby"})
        for body in ({"buttons": [], "recipes": []},
                     {"recipes": {}},
                     {"buttons": [{"page": 1, "button": 1, "off": b64(make_png(100, 100)),
                                   "on": b64(make_png())}], "recipes": {}},
                     {"buttons": [], "recipes": {}, "layout": {"pages": []}}):
            with self.subTest(body=body):
                self.assertEqual(self.json_request("PUT", "/api/projects/Lobby", body)[0], 400)

    def test_load_from_keypad_makes_a_project(self):
        project = self.from_keypad()
        self.assertRegex(project["name"], r"^127-0-0-1 \d{4}-\d\d-\d\d$")
        self.assertEqual(project["baseFingerprint"], Design.from_cpio(self.data).fingerprint)
        self.assertEqual(len(project["config"]["pages"]), 2)

    def test_load_from_keypad_twice_makes_two_projects(self):
        first, second = self.from_keypad(), self.from_keypad()
        self.assertEqual(second["name"], first["name"] + " 2")

    def test_load_from_unreachable_keypad_is_502(self):
        self.ops.port = 1
        status, body = self.json_request("POST", "/api/projects/from-keypad", {"host": "127.0.0.1"})
        self.assertEqual(status, 502)
        self.assertIn("127.0.0.1", body["error"])

    def test_load_from_keypad_without_design_is_504(self):
        self.keypad.ignore.add("getfile")
        self.ops.timeout = 0.5
        status, body = self.json_request("POST", "/api/projects/from-keypad", {"host": "127.0.0.1"})
        self.assertEqual(status, 504)
        self.assertIn("no design loaded", body["error"])

    # -- Deploy -----------------------------------------------------------------------------

    def test_deploy_loaded_project_records_the_new_fingerprint(self):
        project = self.from_keypad()
        status, result = self.json_request("POST", f"/api/projects/{urllib.parse.quote(project['name'])}/deploy",
                                           {"host": "127.0.0.1"})
        self.assertEqual(status, 200, result)
        self.assertEqual(Design.from_cpio(self.keypad.files[DESIGN_PATH]).fingerprint, result["fingerprint"])
        self.assertTrue(result["backup"].startswith("backup_"))
        self.assertEqual(self.projects.base_fingerprint(project["name"]), result["fingerprint"])
        backups = self.json_request("GET", "/api/backups")[1]
        self.assertIn(result["backup"], [b["name"] for b in backups])
        reopened = self.json_request("GET", f"/api/projects/{urllib.parse.quote(project['name'])}")[1]
        self.assertEqual(reopened["lastDeployed"], result["deployed"])

    def test_backups_list_kind_size_date_and_model(self):
        self.from_keypad()                       # Saves loaded_<time>.cpio.
        status, backups = self.json_request("GET", "/api/backups")
        self.assertEqual(status, 200, backups)
        self.assertEqual(len(backups), 1)
        backup = backups[0]
        self.assertEqual((backup["kind"], backup["size"], backup["model"]),
                         ("loaded", len(self.data), "OMNI-KP-8BV"))
        self.assertRegex(backup["saved"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$")

    def test_back_up_now_saves_a_manual_backup(self):
        status, result = self.json_request("POST", "/api/backups", {"host": "127.0.0.1"})
        self.assertEqual(status, 200, result)
        self.assertTrue(result["name"].startswith("manual_"))
        self.assertEqual([b["name"] for b in self.json_request("GET", "/api/backups")[1]],
                         [result["name"]])

    def test_back_up_now_needs_a_host(self):
        status, result = self.json_request("POST", "/api/backups", {})
        self.assertEqual(status, 400, result)

    def test_deploy_new_project_to_keypad_without_design(self):
        self.keypad.ignore.add("getfile")
        self.ops.timeout = 0.5
        self.json_request("POST", "/api/projects", {"name": "Lobby"})
        status, result = self.json_request("POST", "/api/projects/Lobby/deploy", {"host": "127.0.0.1"})
        self.assertEqual((status, result["backup"]), (200, ""))
        uploaded = Design.from_cpio(self.keypad.files[DESIGN_PATH])
        self.assertEqual([p["name"] for p in uploaded.pages], ["Page 1"])

    def test_deploy_over_a_different_design_is_409_then_force(self):
        self.json_request("POST", "/api/projects", {"name": "Lobby"})
        status, body = self.json_request("POST", "/api/projects/Lobby/deploy", {"host": "127.0.0.1"})
        self.assertEqual((status, body.get("conflict")), (409, True))
        self.assertEqual(self.keypad.files[DESIGN_PATH], self.data)
        status, result = self.json_request("POST", "/api/projects/Lobby/deploy",
                                           {"host": "127.0.0.1", "force": True})
        self.assertEqual(status, 200, result)

    def test_deploy_timeout_is_504_with_backup(self):
        project = self.from_keypad()
        self.wait.side_effect = TimeoutError("slow")
        status, body = self.json_request("POST", f"/api/projects/{urllib.parse.quote(project['name'])}/deploy",
                                         {"host": "127.0.0.1"})
        self.assertEqual(status, 504)
        self.assertTrue(body["backup"].startswith("backup_"))

    def test_failed_upload_is_502_with_backup(self):
        project = self.from_keypad()
        with mock.patch.object(keypad_ops.designs, "upload", side_effect=ConnectionResetError("reset")):
            status, body = self.json_request("POST", f"/api/projects/{urllib.parse.quote(project['name'])}/deploy",
                                             {"host": "127.0.0.1"})
        self.assertEqual(status, 502)
        self.assertTrue(body["backup"].startswith("backup_"))

    def test_deploy_missing_project_is_404(self):
        self.assertEqual(self.json_request("POST", "/api/projects/Nope/deploy",
                                           {"host": "127.0.0.1"})[0], 404)

    def test_disk_errors_on_save_are_500_not_keypad_errors(self):
        self.json_request("POST", "/api/projects", {"name": "Lobby"})
        with mock.patch.object(self.projects, "save", side_effect=PermissionError("locked")):
            status, body = self.json_request("PUT", "/api/projects/Lobby", {"buttons": [], "recipes": {}})
        self.assertEqual(status, 500)
        self.assertIn("couldn't read or write", body["error"])
        self.assertNotIn("keypad", body["error"])

    def test_failure_to_record_a_deploy_says_the_keypad_was_updated(self):
        project = self.from_keypad()
        with mock.patch.object(self.projects, "set_base", side_effect=PermissionError("locked")):
            status, body = self.json_request(
                "POST", f"/api/projects/{urllib.parse.quote(project['name'])}/deploy", {"host": "127.0.0.1"})
        self.assertEqual(status, 500)
        self.assertIn("has the new design", body["error"])

    def test_new_project_can_ask_for_a_free_name(self):
        self.json_request("POST", "/api/projects", {"name": "Untitled"})
        status, project = self.json_request("POST", "/api/projects", {"name": "Untitled", "unique": True})
        self.assertEqual((status, project["name"]), (200, "Untitled 2"))

    def test_old_design_routes_are_gone(self):
        self.assertEqual(self.json_request("POST", "/api/design/load", {"host": "127.0.0.1"})[0], 404)
        self.assertEqual(self.json_request("POST", "/api/design/deploy", {"host": "127.0.0.1"})[0], 404)

    # -- Library ----------------------------------------------------------------------------

    def test_library_crud(self):
        status, saved = self.json_request("PUT", "/api/library/HDMI%201",
                                          {"recipe": RECIPE, "thumbnail": b64(make_png())})
        self.assertEqual((status, saved["name"]), (200, "HDMI 1"))
        self.assertEqual([i["name"] for i in self.json_request("GET", "/api/library")[1]], ["HDMI 1"])
        self.assertEqual(self.json_request("GET", "/api/library/HDMI%201")[1]["name"], "HDMI 1")
        self.assertEqual(self.json_request("DELETE", "/api/library/HDMI%201")[0], 200)
        self.assertEqual(self.json_request("GET", "/api/library/HDMI%201")[0], 404)

    def test_library_rejects_unsafe_name(self):
        status, _ = self.json_request("PUT", "/api/library/..%2Fx",
                                      {"recipe": RECIPE, "thumbnail": b64(make_png())})
        self.assertEqual(status, 400)

    # -- Request hygiene --------------------------------------------------------------------

    def test_writes_without_json_content_type_are_refused(self):
        # A cross-site page can send text/plain without a CORS preflight.
        req = urllib.request.Request(self.base + "/api/projects", method="POST",
                                     data=json.dumps({"name": "Evil"}).encode(),
                                     headers={"Content-Type": "text/plain"})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=10)
        with caught.exception:
            self.assertEqual(caught.exception.code, 415)
        self.assertEqual(self.projects.list(), [])

    def test_refused_write_with_large_body_still_gets_a_reply(self):
        # The server must read the body before it answers, or Windows resets
        # the connection and the client never sees the 415.
        req = urllib.request.Request(self.base + "/api/projects", method="POST",
                                     data=b"x" * 2_000_000, headers={"Content-Type": "text/plain"})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=10)
        with caught.exception:
            self.assertEqual(caught.exception.code, 415)

    def test_requests_for_another_host_name_are_refused(self):
        # DNS rebinding: a page on evil.example resolves to 127.0.0.1.
        req = urllib.request.Request(self.base + "/api/assets", headers={"Host": "evil.example:8044"})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=10)
        with caught.exception:
            self.assertEqual(caught.exception.code, 403)

    def test_localhost_host_name_is_allowed(self):
        port = self.server.server_address[1]
        req = urllib.request.Request(self.base + "/api/assets", headers={"Host": f"localhost:{port}"})
        with urllib.request.urlopen(req, timeout=10) as response:
            self.assertEqual(response.status, 200)

    def test_programming_errors_are_500_not_400(self):
        with mock.patch.object(self.ops, "backup_info", side_effect=TypeError("bug")), \
                mock.patch("traceback.print_exc"):
            status, body = self.json_request("GET", "/api/backups")
        self.assertEqual(status, 500)

    def test_bad_json_is_400_and_unknown_route_is_404(self):
        self.assertEqual(self.request("POST", "/api/projects", raw=b"{nope")[0], 400)
        self.assertEqual(self.request("POST", "/api/projects", body={})[0], 400)
        self.assertEqual(self.request("GET", "/api/nothing")[0], 404)

    def test_models_route(self):
        status, models = self.json_request("GET", "/api/models")
        self.assertEqual(status, 200)
        self.assertEqual([m["id"] for m in models], ["OMNI-KP-6B", "OMNI-KP-6BV", "OMNI-KP-8BV"])
        self.assertEqual([m["name"] for m in models], ["6B", "6BV", "8BV"])
        self.assertNotIn("template", models[0])

    def test_new_project_with_model(self):
        status, project = self.json_request("POST", "/api/projects",
                                            {"name": "Lobby", "model": "OMNI-KP-6BV"})
        self.assertEqual((status, project["model"]), (200, "OMNI-KP-6BV"))
        self.assertEqual(len(project["config"]["pages"][0]["buttons"]), 6)

    def test_new_project_with_unknown_model_is_400(self):
        status, body = self.json_request("POST", "/api/projects", {"name": "Lobby", "model": "OMNI-KP-9X"})
        self.assertEqual(status, 400, body)

    def test_load_from_keypad_records_its_model(self):
        self.assertEqual(self.from_keypad()["model"], "OMNI-KP-8BV")

    def test_load_from_unsupported_keypad_is_400(self):
        self.keypad.params["/configuration/device/model"]["value"] = "OMNI-KP-V"
        status, body = self.json_request("POST", "/api/projects/from-keypad", {"host": "127.0.0.1"})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "The keypad at 127.0.0.1 is an OMNI-KP-V. "
                                        "The designer supports the 6B, 6BV, and 8BV.")
        self.assertEqual(self.projects.list(), [])

    def test_deploy_to_another_model_is_409(self):
        self.json_request("POST", "/api/projects", {"name": "Lobby", "model": "OMNI-KP-6BV"})
        status, body = self.json_request("POST", "/api/projects/Lobby/deploy",
                                         {"host": "127.0.0.1", "force": True})
        self.assertEqual((status, body.get("model")), (409, True))
        self.assertEqual(body["error"], "This project is for a 6BV, but the keypad at 127.0.0.1 is an 8BV.")
        self.assertEqual(self.keypad.files[DESIGN_PATH], self.data)

    def test_old_project_deploys_to_an_8bv(self):
        project = self.from_keypad()
        meta = Path(self.projects.folder) / project["name"] / "designer.json"
        data = json.loads(meta.read_text(encoding="utf-8"))
        del data["model"]
        meta.write_text(json.dumps(data), encoding="utf-8")
        status, result = self.json_request(
            "POST", f"/api/projects/{urllib.parse.quote(project['name'])}/deploy", {"host": "127.0.0.1"})
        self.assertEqual(status, 200, result)

    def test_deploy_project_with_unknown_model_is_400(self):
        self.json_request("POST", "/api/projects", {"name": "Lobby"})
        meta = Path(self.projects.folder) / "Lobby" / "designer.json"
        data = json.loads(meta.read_text(encoding="utf-8"))
        data["model"] = "OMNI-KP-9X"
        meta.write_text(json.dumps(data), encoding="utf-8")
        status, body = self.json_request("POST", "/api/projects/Lobby/deploy", {"host": "127.0.0.1"})
        self.assertEqual(status, 400)
        self.assertIn("OMNI-KP-9X", body["error"])

    def write_backup(self, data):
        name = "backup_20260101_000000.cpio"
        (self.ops.backup_dir / name).write_bytes(data)
        return name

    def test_restore_6bv_backup_to_8bv_is_409(self):
        template = self.projects.models["OMNI-KP-6BV"].template
        name = self.write_backup(Design(copy.deepcopy(template)).to_cpio())
        status, body = self.json_request("POST", "/api/design/restore",
                                         {"host": "127.0.0.1", "backup": name})
        self.assertEqual(status, 409)
        self.assertIs(body["model"], True)
        self.assertEqual(body["error"],
                         "This backup is for a 6BV, but the keypad at 127.0.0.1 is an 8BV.")
        self.assertEqual(self.keypad.files[DESIGN_PATH], self.data)

    def test_restore_8bv_backup_to_8bv_works(self):
        name = self.write_backup(self.data)
        status, body = self.json_request("POST", "/api/design/restore",
                                         {"host": "127.0.0.1", "backup": name})
        self.assertEqual(status, 200)
        self.assertEqual(body["fingerprint"], Design.from_cpio(self.data).fingerprint)


if __name__ == "__main__":
    unittest.main()
