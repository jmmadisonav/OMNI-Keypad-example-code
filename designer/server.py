#!/usr/bin/env python3
"""Design OMNI keypad button images in your browser and deploy them.

Usage:
    python designer/server.py [--port 8044] [--no-browser]

The server listens on 127.0.0.1 only, and opens the designer in your
default browser.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import sys
import traceback
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))          # For hcontrol, keypad_design, and designer.

from hcontrol import HControlError, discover as hcontrol_discover  # noqa: E402
from designer.assets import GraphicsZip  # noqa: E402
from designer.keypad_ops import (BusyError, ButtonImages, ConflictError,  # noqa: E402
                                 DeployFailed, DeployTimeout, KeypadOps, Layout,
                                 ModelMismatch)
from designer.library import Library  # noqa: E402
from designer.models import DEFAULT_MODEL  # noqa: E402
from designer.projects import ProjectStore, project_name_for  # noqa: E402
from keypad_design import Design  # noqa: E402

MAX_BODY = 32 * 1024 * 1024
STATIC_DIRS = {"static": HERE / "static", "vendor": HERE / "vendor"}
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
    ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8",
}


class HttpError(Exception):
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.extra = extra


def make_server(port: int, ops: KeypadOps, library: Library, graphics: GraphicsZip,
                projects: ProjectStore, discover=hcontrol_discover) -> ThreadingHTTPServer:
    class Handler(_Handler):
        pass
    Handler.ops, Handler.library, Handler.graphics, Handler.projects, Handler.discover = (
        ops, library, graphics, projects, staticmethod(discover))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server


class _Handler(BaseHTTPRequestHandler):
    ops: KeypadOps
    library: Library
    graphics: GraphicsZip
    projects: ProjectStore

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PUT(self):
        self._handle("PUT")

    def do_DELETE(self):
        self._handle("DELETE")

    def log_message(self, format, *args):
        pass                                    # Errors are printed in _handle().

    # -- Dispatch ------------------------------------------------------------------

    def _handle(self, method: str) -> None:
        path = urllib.parse.urlsplit(self.path).path
        self._host = None                         # Set by _host_from() on keypad routes.
        try:
            # Read the body first, so an early refusal doesn't reset the connection.
            self._raw = self._read_body() if method in ("POST", "PUT", "DELETE") else b""
            self._check_origin(method)
            self._route(method, path)
        except HttpError as error:
            self._json({"error": str(error), **error.extra}, error.status)
        except ConflictError as error:
            self._json({"error": str(error), "conflict": True}, 409)
        except BusyError as error:
            self._json({"error": str(error), "busy": True}, 409)
        except DeployTimeout as error:
            self._json({"error": str(error), "backup": error.backup}, 504)
        except DeployFailed as error:
            self._json({"error": str(error), "backup": error.backup}, 502)
        except TimeoutError as error:
            self._json({"error": str(error)}, 504)
        except FileExistsError as error:
            self._json({"error": str(error)}, 409)
        except FileNotFoundError as error:
            self._json({"error": str(error)}, 404)
        except ValueError as error:
            self._json({"error": str(error)}, 400)
        except (OSError, HControlError) as error:
            if self._host is None:                # Files, not the network.
                traceback.print_exc()
                self._json({"error": f"couldn't read or write the designer's files: {error}"}, 500)
            else:
                self._json({"error": f"couldn't talk to the keypad at {self._host}: {error}"}, 502)
        except Exception as error:              # Show the traceback in the console.
            traceback.print_exc()
            self._json({"error": f"unexpected error: {error}"}, 500)

    def _check_origin(self, method: str) -> None:
        """Refuse requests that other web pages in your browser could make.

        A page on another site can send a "simple" text/plain POST to
        127.0.0.1 without asking first, and a DNS-rebinding page reaches the
        server under its own host name. Requiring JSON forces a CORS
        preflight, which this server never approves.
        """
        port = self.server.server_address[1]
        if self.headers.get("Host", "") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            raise HttpError(403, "open the designer at http://127.0.0.1:"
                                 f"{port}/ to use it")
        content_type = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if method in ("POST", "PUT", "DELETE") and content_type != "application/json":
            raise HttpError(415, "requests must be sent as application/json")

    def _route(self, method: str, path: str) -> None:
        parts = [urllib.parse.unquote(p) for p in path.split("/") if p]
        if method == "GET" and not parts:
            return self._file(HERE / "static" / "index.html")
        if method == "GET" and parts[0] in STATIC_DIRS:
            return self._static(STATIC_DIRS[parts[0]], parts[1:])
        if method == "GET" and parts[0] == "asset" and len(parts) >= 2:
            try:
                data = self.graphics.read("/".join(parts[1:]))
            except KeyError:
                raise HttpError(404, "there's no such image in Keypad Graphics.zip") from None
            return self._bytes(data, "image/png")
        if parts[:1] != ["api"]:
            raise HttpError(404, f"no such page: {path}")
        route = (method, *parts[1:])
        if route == ("GET", "assets"):
            return self._json(self.graphics.catalog())
        if route == ("GET", "keypads"):
            found = [d for d in self.discover() if str(d.get("model", "")).startswith("OMNI-KP")]
            return self._json([{k: d.get(k, "") for k in ("ip", "name", "model", "version")}
                               for d in found])
        if route == ("GET", "backups"):
            return self._json(self.ops.backups())
        if route == ("POST", "design", "restore"):
            body = self._body()
            return self._json(self.ops.restore(self._host_from(body), _field(body, "backup", str)))
        if route == ("GET", "models"):
            return self._json([m.summary() for m in self.projects.models.values()])
        if route == ("GET", "projects"):
            return self._json(self.projects.list())
        if route == ("POST", "projects"):
            body = self._body()
            model = body.get("model") or DEFAULT_MODEL
            if not isinstance(model, str):
                raise ValueError("model must be a keypad model id, such as OMNI-KP-8BV")
            return self._json(self.projects.new(_field(body, "name", str).strip(), model,
                                                unique=bool(body.get("unique"))))
        if route == ("POST", "projects", "from-keypad"):
            body = self._body()
            host = self._host_from(body)
            model = self.ops.keypad_model(host)
            if model not in self.projects.models:
                raise ValueError(f"The keypad at {host} is {_article(model)}. "
                                 f"The designer supports the {_supported(self.projects)}.")
            data = self.ops.download(host)
            name = self.projects.unique_name(project_name_for(host))
            return self._json(self.projects.import_design(
                name, data, Design.from_cpio(data).fingerprint, model))
        if len(route) == 3 and route[1] == "projects":
            name = route[2]
            if method == "GET":
                return self._json(self.projects.open(name))
            if method == "PUT":
                body = self._body()
                buttons = [ButtonImages.from_json(item) for item in _field(body, "buttons", list)]
                layout = (Layout.from_json(_field(body, "layout", dict))
                          if body.get("layout") is not None else None)
                return self._json(self.projects.save(name, buttons, layout,
                                                     _field(body, "recipes", dict)))
        if len(route) == 4 and route[1] == "projects" and method == "POST":
            name, action = route[2], route[3]
            body = self._body()
            if action == "copy":
                return self._json(self.projects.copy(name, _field(body, "to", str).strip()))
            if action == "deploy":
                host = self._host_from(body)
                design = self.projects.design(name)
                model = self.projects.model_of(name)
                if model not in self.projects.models:
                    raise ValueError(f"{name} is for {_article(model)}, which the designer "
                                     "doesn't know. Put its model file back in designer/models/.")
                try:
                    result = self.ops.deploy_project(
                        host, design, self.projects.base_fingerprint(name),
                        force=bool(body.get("force")), model=model)
                except ModelMismatch as error:
                    raise HttpError(409, f"This project is for "
                                         f"{_article(_model_name(self.projects, error.expected))}, "
                                         f"but the keypad at {host} is "
                                         f"{_article(_model_name(self.projects, error.actual))}.",
                                    model=True) from None
                try:
                    self.projects.set_base(name, result["fingerprint"])
                except OSError as error:
                    raise HttpError(500, f"the keypad at {host} has the new design, but the "
                                         f"designer couldn't record that in {name}: {error}") from None
                return self._json(result)
        if route == ("GET", "library"):
            return self._json(self.library.list())
        if len(route) == 3 and route[1] == "library":
            name = route[2]
            if method == "GET":
                return self._json(self.library.get(name))
            if method == "PUT":
                body = self._body()
                try:
                    thumbnail = base64.b64decode(_field(body, "thumbnail", str), validate=True)
                except binascii.Error:
                    raise ValueError("the thumbnail isn't valid base64") from None
                return self._json(self.library.save(name, _field(body, "recipe", dict), thumbnail))
            if method == "DELETE":
                self.library.delete(name)
                return self._json({})
        raise HttpError(404, f"no such API: {method} {path}")

    # -- Requests and responses ---------------------------------------------------------

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0:
            self.close_connection = True
            raise HttpError(400, "the request has an invalid Content-Length")
        if length > MAX_BODY:
            self.close_connection = True          # Don't read it; drop the connection.
            raise HttpError(413, "the request is too large")
        return self.rfile.read(length)

    def _body(self) -> dict:
        try:
            body = json.loads(self._raw or b"{}")
        except json.JSONDecodeError as error:
            raise HttpError(400, f"the request isn't valid JSON: {error}") from None
        if not isinstance(body, dict):
            raise HttpError(400, "the request must be a JSON object")
        return body

    def _host_from(self, body: dict) -> str:
        host = str(body.get("host") or "").strip()
        if not host:
            raise ValueError("enter the keypad's IP address")
        self._host = host
        return host

    def _static(self, folder: Path, parts: list[str]) -> None:
        target = folder.joinpath(*parts).resolve() if parts else folder
        if not target.is_relative_to(folder.resolve()) or not target.is_file():
            raise HttpError(404, "file not found")
        self._file(target)

    def _file(self, path: Path) -> None:
        self._bytes(path.read_bytes(),
                    CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream"))

    def _json(self, value, status: int = 200) -> None:
        self._bytes(json.dumps(value).encode("utf-8"), "application/json", status)

    def _bytes(self, data: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def _article(name: str) -> str:
    """Return "an 8BV" or "a 6BV"."""
    return f"{'an' if name[:1].upper() in '8AEIOU' else 'a'} {name}"


def _model_name(projects: ProjectStore, model: str) -> str:
    known = projects.models.get(model)
    return known.name if known else model


def _supported(projects: ProjectStore) -> str:
    names = [m.name for m in projects.models.values()]
    return ", ".join(names[:-1]) + f", and {names[-1]}" if len(names) > 1 else names[0]


def _field(body: dict, key: str, kind: type):
    """Return body[key], or raise ValueError if it's missing or the wrong type."""
    value = body.get(key)
    if not isinstance(value, kind):
        raise ValueError(f"the request needs \"{key}\" ({kind.__name__})")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8044)
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser")
    args = parser.parse_args()
    try:
        projects = ProjectStore(HERE / "projects")
    except ValueError as error:
        sys.exit(f"The designer couldn't start: {error}")
    try:
        server = make_server(args.port, KeypadOps(HERE / "backups"), Library(HERE / "library"),
                             GraphicsZip(), projects)
    except OSError as error:
        sys.exit(f"Couldn't listen on port {args.port}: {error}. Try --port with another number.")
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Button designer running at {url}. Press Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
