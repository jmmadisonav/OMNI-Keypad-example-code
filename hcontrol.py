"""A small HControl client for BSS OMNI keypads.

HControl is a line-based protocol over TCP port 4197. Each message is a
command name followed by a JSON object and a line feed, for example:

    set {"path":"/page1/button1/state","format":"string","value":"ON"}

The keypad answers each request with a reply that starts with "@", such as
"@set {...}". When a parameter you subscribed to changes, the keypad sends
"publish {...}", and you must answer with "@publish" before it sends the next
one.

This module uses only the Python standard library.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import queue
import socket
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable, Iterator

log = logging.getLogger("hcontrol")

DEFAULT_PORT = 4197

Callback = Callable[[str, Any], None]


class HControlError(Exception):
    """The keypad answered a request with an error."""

    def __init__(self, path: str, message: str):
        super().__init__(f"{path}: {message}")
        self.path = path
        self.message = message


def encode(command: str, params: dict | None = None) -> bytes:
    """Build one protocol line, for example b'get {"path":"/x"}\\n'."""
    if params is None:
        return f"{command}\n".encode("utf-8")
    body = json.dumps(params, separators=(",", ":"))
    return f"{command} {body}\n".encode("utf-8")


def decode(line: str) -> tuple[str, Any]:
    """Split one protocol line into its command and its parsed JSON body."""
    command, _, body = line.strip().partition(" ")
    body = body.strip()
    return command, (json.loads(body) if body else None)


class HControlClient:
    """A connection to one keypad.

    Requests run in lockstep: the client sends one request and waits for its
    reply before it sends the next, as the protocol requires. A reader thread
    receives everything the keypad sends and acknowledges publish messages
    straight away. A dispatcher thread calls your subscription callbacks, so a
    callback can safely call get() or set().
    """

    def __init__(
        self,
        host: str,
        port: int = DEFAULT_PORT,
        timeout: float = 5.0,
        on_disconnect: Callable[[], None] | None = None,
    ):
        self.timeout = timeout
        self._on_disconnect = on_disconnect
        self._sock = socket.create_connection((host, port), timeout=timeout)
        self._sock.settimeout(None)
        self._send_lock = threading.Lock()
        self._request_lock = threading.Lock()
        self._replies: queue.Queue = queue.Queue()
        self._events: queue.Queue = queue.Queue()
        self._callbacks: dict[str, list[Callback]] = {}
        self._callbacks_lock = threading.Lock()
        self._closing = False
        self._closed = threading.Event()
        self._reader = threading.Thread(
            target=self._read_loop, name="hcontrol-reader", daemon=True)
        self._dispatcher = threading.Thread(
            target=self._dispatch_loop, name="hcontrol-dispatcher", daemon=True)
        self._reader.start()
        self._dispatcher.start()

    # -- Context manager -------------------------------------------------

    def __enter__(self) -> HControlClient:
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    def close(self) -> None:
        """Close the connection. Safe to call more than once."""
        if self._closing:
            return
        self._closing = True
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._sock.close()
        if threading.current_thread() is not self._reader:
            self._reader.join(timeout=2)
        if threading.current_thread() is not self._dispatcher:
            self._dispatcher.join(timeout=2)

    @property
    def connected(self) -> bool:
        return not self._closed.is_set()

    # -- Parameters -------------------------------------------------------

    def get(self, path: str, fmt: str | None = None) -> Any:
        """Read a parameter. Pass fmt="string" to get enums as names."""
        reply = self._request("get", _params(path, fmt))
        return reply.get("value")

    def set(self, path: str, value: Any, fmt: str | None = None) -> Any:
        """Write a parameter and return the value the keypad applied.

        The keypad clamps numbers to the range in the design, so the
        returned value can differ from the one you sent.
        """
        params = _params(path, fmt)
        params["value"] = value
        reply = self._request("set", params)
        return reply.get("value")

    def subscribe(self, path: str, callback: Callback, fmt: str | None = None) -> Any:
        """Call callback(path, value) whenever the parameter changes.

        Returns the parameter's current value.
        """
        with self._callbacks_lock:
            self._callbacks.setdefault(path, []).append(callback)
        try:
            reply = self._request("subscribe", _params(path, fmt))
        except Exception:
            with self._callbacks_lock:
                self._callbacks[path].remove(callback)
                if not self._callbacks[path]:
                    del self._callbacks[path]
            raise
        return reply.get("value")

    def unsubscribe(self, path: str | None = None) -> None:
        """Stop one subscription, or all of them when path is None."""
        if path is None:
            self._request("unsubscribe", None)
            with self._callbacks_lock:
                self._callbacks.clear()
        else:
            self._request("unsubscribe", {"path": path})
            with self._callbacks_lock:
                self._callbacks.pop(path, None)

    def exec(self, path: str, command: str, **arguments: Any) -> Any:
        """Run a command, for example exec("/configuration/commands", "reset")."""
        params: dict[str, Any] = {"path": path, "command": command}
        if arguments:
            params["arguments"] = arguments
        return self._request("exec", params)

    # -- Files -------------------------------------------------------------

    def get_file(self, path: str) -> bytes:
        """Download a file, such as the descriptor or /project/project.cpio."""
        with self._request_lock:
            begin = self._exchange(
                "getfile", {"blocksize": 65536, "path": path, "state": "begin"})
            length = begin["length"]
            chunks = []
            while True:
                block = self._wait_for("block")
                if not block or "data" not in block:
                    self._send("@block", {})
                    break
                chunks.append(block["data"])
                self._send("@block", {"blockno": block["blockno"]})
            self._exchange("getfile", {"length": length, "state": "end"})
        data = base64.b64decode("".join(chunks))
        if len(data) != length:
            raise HControlError(path, f"expected {length} bytes, received {len(data)}")
        return data

    def put_file(self, path: str, data: bytes) -> None:
        """Upload a file. The keypad checks it against an MD5 checksum."""
        encoded = base64.b64encode(data).decode("ascii")
        with self._request_lock:
            begin = self._exchange(
                "putfile",
                {"blocksize": 65536, "length": len(data), "path": path, "state": "begin"})
            blocksize = begin["blocksize"]
            for blockno, start in enumerate(range(0, len(encoded), blocksize), start=1):
                self._send("block", {"blockno": blockno, "data": encoded[start:start + blocksize]})
                ack = self._wait_for("@block")
                if ack.get("blockno") != blockno:
                    raise HControlError(
                        path, f"block {blockno} acknowledged as {ack.get('blockno')}")
            self._exchange(
                "putfile",
                {"checksum": hashlib.md5(data).hexdigest(), "length": len(data), "state": "end"})

    # -- Internals -----------------------------------------------------------

    def _request(self, command: str, params: dict | None) -> dict:
        with self._request_lock:
            return self._exchange(command, params)

    def _exchange(self, command: str, params: dict | None) -> dict:
        self._discard_stale_replies()
        self._send(command, params)
        path = params.get("path") if params else None
        return self._wait_for("@" + command, path)

    def _discard_stale_replies(self) -> None:
        # A reply that arrived after its request timed out.
        while True:
            try:
                item = self._replies.get_nowait()
            except queue.Empty:
                break
            if item is None:
                self._replies.put(None)
                break

    def _send(self, command: str, params: dict | None) -> None:
        if self._closed.is_set():
            raise ConnectionError("not connected to the keypad")
        self._send_line(encode(command, params))

    def _send_line(self, line: bytes) -> None:
        log.debug("-> %s", line.decode("utf-8").rstrip())
        with self._send_lock:
            self._sock.sendall(line)

    def _wait_for(self, expected: str, path: str | None = None) -> dict:
        deadline = time.monotonic() + self.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"no {expected} reply within {self.timeout} s")
            try:
                item = self._replies.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError(f"no {expected} reply within {self.timeout} s") from None
            if item is None:
                self._replies.put(None)  # Wake any other waiter too.
                raise ConnectionError("connection to the keypad closed")
            command, params = item
            params = params if isinstance(params, dict) else {}
            if command != expected or (path and params.get("path", path) != path):
                log.warning("ignoring %s %s while waiting for %s", command, params, expected)
                continue
            if "error" in params:
                raise HControlError(params.get("path", path or ""), params["error"])
            return params

    def _read_loop(self) -> None:
        buffer = b""
        try:
            while True:
                chunk = self._sock.recv(65536)
                if not chunk:
                    break
                # The protocol allows either LF or CR as the line terminator.
                buffer += chunk.replace(b"\r", b"\n")
                *lines, buffer = buffer.split(b"\n")
                for raw in lines:
                    if raw:
                        self._handle_line(raw.decode("utf-8", errors="replace"))
        except OSError:
            pass
        finally:
            self._closed.set()
            self._replies.put(None)
            self._events.put(None)
            if not self._closing and self._on_disconnect:
                try:
                    self._on_disconnect()
                except Exception:
                    log.exception("on_disconnect callback failed")

    def _handle_line(self, line: str) -> None:
        log.debug("<- %s", line)
        try:
            command, params = decode(line)
        except json.JSONDecodeError:
            log.warning("ignoring line that isn't valid JSON: %s", line)
            return
        if command == "publish":
            # Acknowledge first; the keypad sends nothing more until we do.
            try:
                self._send_line(("@" + line + "\n").encode("utf-8"))
            except OSError:
                return
            self._events.put(params)
        else:
            self._replies.put((command, params))

    def _dispatch_loop(self) -> None:
        while True:
            params = self._events.get()
            if params is None:
                return
            path = params.get("path")
            with self._callbacks_lock:
                callbacks = list(self._callbacks.get(path, ()))
            for callback in callbacks:
                try:
                    callback(path, params.get("value"))
                except Exception:
                    log.exception("callback for %s failed", path)


def _params(path: str, fmt: str | None) -> dict:
    params: dict[str, Any] = {"path": path}
    if fmt:
        params["format"] = fmt
    return params


# -- Discovery ----------------------------------------------------------------

DISCO_PARAMS = [
    "ip", "port", "mac", "name", "location", "classname", "model",
    "manufacturer", "guid", "serialnumber", "mode", "devicestate",
    "family", "version",
]


def discover(
    timeout: float = 3.0,
    port: int = DEFAULT_PORT,
    broadcast: str = "255.255.255.255",
) -> list[dict]:
    """Find HControl devices on the local network.

    Sends a UDP "disco" broadcast and collects the "@disco" replies. Each
    result is a dict with keys such as ip, model, name, guid, and version.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.bind(("", 0))
        reply_port = sock.getsockname()[1]
        sock.sendto(encode("disco", {"replyport": reply_port, "params": DISCO_PARAMS}),
                    (broadcast, port))
        found: dict[str, dict] = {}
        deadline = time.monotonic() + timeout
        while (remaining := deadline - time.monotonic()) > 0:
            sock.settimeout(remaining)
            try:
                data, address = sock.recvfrom(65536)
            except socket.timeout:
                break
            except ConnectionResetError:
                # Windows reports ICMP "port unreachable" from other hosts this
                # way. Keep listening for the remaining replies.
                continue
            try:
                command, params = decode(data.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                continue
            if command == "@disco" and isinstance(params, dict):
                params.setdefault("ip", address[0])
                found[params.get("guid") or address[0]] = params
    return list(found.values())


# -- Descriptors ----------------------------------------------------------------

@dataclass(frozen=True)
class ParamInfo:
    """One parameter or command found in a descriptor."""

    path: str
    kind: str                    # "param" or "command"
    type: str | None = None      # boolean, integer, float, enum, string, ...
    access: str | None = None    # rw, ro, or c (constant)
    minimum: Any = None
    maximum: Any = None
    enums: tuple = ()
    flags: tuple = ()
    arguments: dict | None = None
    name: str | None = None


def walk_descriptor(desc: dict, path: str = "") -> Iterator[ParamInfo]:
    """Yield every parameter and command in a descriptor, with its full path.

    Array items are numbered from 1, so the first page is /pages/1.
    """
    kind = desc.get(".kind")
    if kind in ("param", "command"):
        yield ParamInfo(
            path=path,
            kind=kind,
            type=desc.get(".type"),
            access=desc.get(".access"),
            minimum=desc.get(".min"),
            maximum=desc.get(".max"),
            enums=tuple(desc.get(".enums", ())),
            flags=tuple(desc.get(".flags", ())),
            arguments=desc.get(".arguments"),
            name=desc.get(".name"),
        )
        return
    if kind == "array":
        items = desc.get(".items") or []
        size = desc.get(".size", len(items))
        for index in range(size):
            item = items[index] if index < len(items) else desc.get(".prototype", {})
            yield from walk_descriptor(item, f"{path}/{index + 1}")
        return
    for key, child in desc.items():
        if not key.startswith(".") and isinstance(child, dict):
            yield from walk_descriptor(child, f"{path}/{key}")


def find_param(desc: dict, path: str) -> ParamInfo:
    """Return the ParamInfo for path, or raise KeyError."""
    for info in walk_descriptor(desc):
        if info.path == path:
            return info
    raise KeyError(path)


def validate(desc: dict, path: str, value: Any) -> None:
    """Check a value against the descriptor before you send it.

    Raises ValueError with a readable message when the path doesn't exist,
    isn't writable, or the value has the wrong type or is out of range.
    Enum values can be names ("ON") or indexes (2).
    """
    try:
        info = find_param(desc, path)
    except KeyError:
        raise ValueError(f"{path} isn't in the descriptor") from None
    if info.kind != "param":
        raise ValueError(f"{path} is a {info.kind}, not a parameter")
    if info.access not in (None, "rw", "w"):
        raise ValueError(f"{path} is read-only")

    if info.type == "enum":
        if isinstance(value, str):
            if value not in info.enums:
                raise ValueError(
                    f"{path} must be one of {' | '.join(info.enums)}, not {value!r}")
        elif isinstance(value, int) and not isinstance(value, bool):
            if not 0 <= value < len(info.enums):
                raise ValueError(
                    f"{path} index must be 0 to {len(info.enums) - 1}, not {value}")
        else:
            raise ValueError(f"{path} needs an enum name or index, not {value!r}")
    elif info.type in ("integer", "float"):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{path} needs a number, not {value!r}")
        if info.type == "integer" and not float(value).is_integer():
            raise ValueError(f"{path} needs a whole number, not {value}")
        if info.minimum is not None and value < info.minimum:
            raise ValueError(f"{path} value {value} is below the minimum of {info.minimum}")
        if info.maximum is not None and value > info.maximum:
            raise ValueError(f"{path} value {value} is above the maximum of {info.maximum}")
    elif info.type == "boolean":
        if not isinstance(value, bool):
            raise ValueError(f"{path} needs true or false, not {value!r}")
    elif info.type in ("string", "dstring"):
        if not isinstance(value, str):
            raise ValueError(f"{path} needs a string, not {value!r}")
        if info.maximum is not None and len(value) > info.maximum:
            raise ValueError(f"{path} can be at most {info.maximum} characters")
