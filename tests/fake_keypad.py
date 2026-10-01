"""A fake OMNI keypad for unit tests.

FakeKeypad is a threaded TCP server on 127.0.0.1 that answers HControl
requests the way the real keypad (firmware 1.1.4.0) does:

- A publish caused by a set is sent before the @set reply.
- Only one publish is outstanding per connection until the client sends
  @publish.
- Numbers are clamped to the parameter's range.
- Enums are returned as indexes unless the request asks for "format":"string".
- Error replies use the keypad's own messages, such as "unknown path".
- getfile and putfile use 1000-character base64 blocks and an MD5 check.
"""

from __future__ import annotations

import base64
import collections
import copy
import hashlib
import json
import socket
import socketserver
import threading
import time

UNKNOWN_PATH = "unknown path"
BAD_VALUE = "error bad param value"


def default_params(pages: int = 2) -> dict[str, dict]:
    """Parameters for a third-party design with every control unbound."""
    names = [f"Page {n}" for n in range(1, pages + 1)]
    params: dict[str, dict] = {
        "/configuration/device/model": {"value": "OMNI-KP-8BV", "access": "ro"},
        "/configuration/device/version": {"value": "1.1.4.0", "access": "ro"},
        "/configuration/device/fingerprint": {"value": "0" * 32, "access": "ro"},
        "/configuration/device/descriptorlocation": {
            "value": "descriptor/hornet.json", "access": "ro"},
        "/settings/currentpage": {"value": 0, "enums": names},
        "/settings/brightness": {"value": 50, "min": 0, "max": 100},
    }
    for page in range(1, pages + 1):
        params[f"/pages/{page}/name"] = {"value": names[page - 1], "access": "ro"}
        params[f"/pages/{page}/background"] = {"value": "#000000"}
        for button in range(1, 9):
            base = f"/page{page}/button{button}"
            params[f"{base}/state"] = {"value": 0, "enums": ["OFF", "Alt", "ON"]}
            params[f"{base}/action"] = {
                "value": 0, "enums": ["RELEASE", "PUSH"], "access": "ro"}
        params[f"/page{page}/dial/level"] = {"value": 0, "min": -100, "max": 10}
        params[f"/page{page}/ledring/level"] = {"value": 0, "min": -100, "max": 10}
        params[f"/page{page}/dial_button/action"] = {
            "value": 0, "enums": ["RELEASE", "PUSH"], "access": "ro"}
    return params


class FakeKeypad:
    """Start with `with FakeKeypad() as keypad:` and connect to keypad.port."""

    def __init__(self, params: dict[str, dict] | None = None):
        self.params = copy.deepcopy(params if params is not None else default_params())
        self.files: dict[str, bytes] = {}
        self.commands = {"/configuration/commands": {"reset"}}
        self.block_chars = 1000
        self.ignore: set[str] = set()     # Commands to leave unanswered.
        self.delay: dict[str, float] = {} # Seconds to wait before answering a command.
        self.received: list[str] = []     # Every line received, in order.
        self.lock = threading.RLock()
        self.sessions: list[_Session] = []
        keypad = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                session = _Session(keypad, self.request)
                with keypad.lock:
                    keypad.sessions.append(session)
                try:
                    session.run()
                finally:
                    with keypad.lock:
                        keypad.sessions.remove(session)

        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self._thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    def __enter__(self) -> FakeKeypad:
        self._thread.start()
        return self

    def __exit__(self, *exc_info) -> None:
        self.disconnect_all()
        self.server.shutdown()
        self.server.server_close()

    # -- Test controls -------------------------------------------------------

    def value(self, path: str, fmt: str | None = "string"):
        """Return a parameter's value, with enums as names by default."""
        with self.lock:
            return _format(self.params[path], fmt)

    def press(self, path: str, value) -> None:
        """Simulate the keypad changing a parameter, such as a button push."""
        with self.lock:
            self.params[path]["value"] = _to_stored(self.params[path], value)
            self._publish(path)

    def disconnect_all(self) -> None:
        with self.lock:
            sessions = list(self.sessions)
        for session in sessions:
            session.close()

    def _publish(self, path: str) -> None:
        with self.lock:
            for session in self.sessions:
                session.publish(path)


class _Session:
    def __init__(self, keypad: FakeKeypad, conn: socket.socket):
        self.keypad = keypad
        self.conn = conn
        self.subscriptions: dict[str, str | None] = {}
        self.pending: collections.deque = collections.deque()
        self.awaiting_ack = False
        self.lock = threading.Lock()
        self.download: list[str] = []
        self.upload: dict | None = None

    def run(self) -> None:
        buffer = b""
        while True:
            try:
                chunk = self.conn.recv(65536)
            except OSError:
                return
            if not chunk:
                return
            buffer += chunk
            *lines, buffer = buffer.split(b"\n")
            for raw in lines:
                line = raw.decode("utf-8").strip()
                if line:
                    self.handle(line)

    def close(self) -> None:
        try:
            self.conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.conn.close()

    def send(self, command: str, params: dict | None = None) -> None:
        line = command if params is None else f"{command} {json.dumps(params, separators=(',', ':'))}"
        try:
            self.conn.sendall(line.encode("utf-8") + b"\n")
        except OSError:
            pass

    # -- Publishing ----------------------------------------------------------

    def publish(self, path: str) -> None:
        with self.lock:
            if path in self.subscriptions:
                self.pending.append(path)
                self._pump()

    def _pump(self) -> None:
        if self.awaiting_ack or not self.pending:
            return
        path = self.pending.popleft()
        fmt = self.subscriptions.get(path)
        self.awaiting_ack = True
        self.send("publish", {"path": path, "format": fmt or "variant",
                              "value": _format(self.keypad.params[path], fmt)})

    # -- Requests ------------------------------------------------------------

    def handle(self, line: str) -> None:
        keypad = self.keypad
        keypad.received.append(line)
        command, _, body = line.partition(" ")
        params = json.loads(body) if body.strip() else None
        if command in keypad.ignore:
            return
        if command in keypad.delay:
            time.sleep(keypad.delay[command])
        handler = getattr(self, "on_" + command.replace("@", "ack_"), None)
        if handler is None:
            self.send("@" + command, {"error": "unknown command"})
            return
        with keypad.lock:
            handler(params)

    def on_ack_publish(self, params) -> None:
        with self.lock:
            self.awaiting_ack = False
            self._pump()

    def _lookup(self, command: str, params: dict):
        path = params.get("path", "")
        param = self.keypad.params.get(path)
        if param is None:
            is_object = any(p.startswith(path + "/") for p in self.keypad.params)
            self.send("@" + command,
                      {"path": path, "error": BAD_VALUE if is_object else UNKNOWN_PATH})
        return path, param

    def _reply(self, command: str, path: str, param: dict, fmt: str | None) -> None:
        reply = {"path": path}
        if fmt:
            reply["format"] = fmt
        reply["value"] = _format(param, fmt)
        self.send("@" + command, reply)

    def on_get(self, params) -> None:
        path, param = self._lookup("get", params)
        if param is not None:
            self._reply("get", path, param, params.get("format"))

    def on_set(self, params) -> None:
        path, param = self._lookup("set", params)
        if param is None:
            return
        if param.get("access") == "ro":
            self.send("@set", {"path": path, "error": "parameter is read only"})
            return
        try:
            stored = _to_stored(param, params.get("value"))
        except ValueError:
            self.send("@set", {"path": path, "error": BAD_VALUE})
            return
        changed = stored != param["value"]
        param["value"] = stored
        if changed:
            self.keypad._publish(path)   # The real keypad publishes before replying.
        self._reply("set", path, param, params.get("format"))

    def on_subscribe(self, params) -> None:
        path, param = self._lookup("subscribe", params)
        if param is not None:
            self.subscriptions[path] = params.get("format")
            self._reply("subscribe", path, param, params.get("format"))

    def on_unsubscribe(self, params) -> None:
        if params is None:
            self.subscriptions.clear()
            self.send("@unsubscribe")
        else:
            self.subscriptions.pop(params.get("path"), None)
            self.send("@unsubscribe", {"path": params.get("path")})

    def on_exec(self, params) -> None:
        if params.get("command") in self.keypad.commands.get(params.get("path"), ()):
            self.send("@exec")
        else:
            self.send("@exec", {"path": params.get("path"), "error": UNKNOWN_PATH})

    # -- File transfer -------------------------------------------------------

    def on_getfile(self, params) -> None:
        if params.get("state") == "end":
            self.send("@getfile", {})
            return
        data = self.keypad.files.get(params.get("path"))
        if data is None:
            self.send("@getfile", {"path": params.get("path"), "error": "file not found"})
            return
        encoded = base64.b64encode(data).decode("ascii")
        size = self.keypad.block_chars
        self.download = [encoded[i:i + size] for i in range(0, len(encoded), size)]
        self.send("@getfile", {"blocksize": size, "length": len(data)})
        self._send_next_block(1)

    def _send_next_block(self, blockno: int) -> None:
        if blockno <= len(self.download):
            self.send("block", {"blockno": blockno, "data": self.download[blockno - 1]})
        else:
            self.send("block", {})

    def on_ack_block(self, params) -> None:
        if params and "blockno" in params:
            self._send_next_block(params["blockno"] + 1)

    def on_putfile(self, params) -> None:
        if params.get("state") == "begin":
            self.upload = {"path": params["path"], "length": params["length"], "blocks": []}
            self.send("@putfile", {"blocksize": self.keypad.block_chars})
            return
        if self.upload is None:
            self.send("@putfile", {"error": "no transfer in progress"})
            return
        upload, self.upload = self.upload, None
        data = base64.b64decode("".join(upload["blocks"]))
        if len(data) != params.get("length") or hashlib.md5(data).hexdigest() != params.get("checksum"):
            self.send("@putfile", {"error": "checksum mismatch"})
            return
        self.keypad.files[upload["path"]] = data
        self.send("@putfile", {})

    def on_block(self, params) -> None:
        if self.upload is None:
            self.send("@block", {"error": "no transfer in progress"})
            return
        blocks = self.upload["blocks"]
        if params.get("blockno") != len(blocks) + 1:
            self.send("@block", {"error": "unexpected block number"})
            return
        blocks.append(params["data"])
        self.send("@block", {"blockno": params["blockno"]})


def _format(param: dict, fmt: str | None):
    value = param["value"]
    if "enums" in param and fmt == "string":
        return param["enums"][value]
    return value


def _to_stored(param: dict, value):
    if "enums" in param:
        if isinstance(value, str):
            if value not in param["enums"]:
                raise ValueError(value)
            return param["enums"].index(value)
        if not 0 <= int(value) < len(param["enums"]):
            raise ValueError(value)
        return int(value)
    if "min" in param and isinstance(value, (int, float)):
        return max(param["min"], min(param["max"], value))
    return value
