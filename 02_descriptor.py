#!/usr/bin/env python3
"""Part 2: Download the keypad's descriptor and use it to find paths.

The descriptor is a JSON file that lists every parameter and command the
keypad exposes for the design it's running. It changes whenever a new design
is deployed, so read it at run time instead of hard-coding paths.

Usage:
    python 02_descriptor.py download [--host IP]
    python 02_descriptor.py list [--host IP] [--filter TEXT]
    python 02_descriptor.py run [--host IP] [--resend]
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
from pathlib import Path

from hcontrol import (DEFAULT_PORT, HControlClient, HControlError, ParamInfo,
                      discover, validate, walk_descriptor)


# The LED ring follows every dial event. Writes that close together can
# make the keypad pause dial updates for 500 ms (firmware 1.1.4.0), so
# once the knob has been still for longer than that, send the last level
# again to make sure the ring shows the right value.
# The resend is off by default; turn it on with --resend (-r).
RESEND_AFTER = 0.6


def download_descriptor(kp: HControlClient, cache_dir: Path = Path(".")) -> tuple[dict, Path]:
    """Return the descriptor, downloading it only if the design changed.

    The file name includes the design's fingerprint, which changes with every
    design upload, so a cached copy is current when the fingerprints match.
    """
    fingerprint = kp.get("/configuration/device/fingerprint", fmt="string")
    cache = Path(cache_dir) / f"descriptor_{fingerprint}.json"
    if cache.exists():
        try:
            return json.loads(cache.read_text(encoding="utf-8")), cache
        except ValueError:
            pass              # A damaged cache file; download it again.
    location = kp.get("/configuration/device/descriptorlocation", fmt="string")
    data = kp.get_file(location)
    desc = json.loads(data)
    # Write to a temporary file first, so an interrupted run never leaves a
    # half-written cache behind.
    partial = cache.with_suffix(".tmp")
    partial.write_bytes(data)
    os.replace(partial, cache)
    return desc, cache


def describe(info: ParamInfo) -> str:
    """Summarize a parameter's allowed values, for example 'OFF | Alt | ON'."""
    if info.kind == "command":
        args = []
        for name, spec in (info.arguments or {}).items():
            values = "|".join(spec.get(".enums", [])) or spec.get(".type", "")
            args.append(f"{name}: {values}" + (" (optional)" if spec.get(".optional") else ""))
        return ", ".join(args)
    if info.enums:
        return " | ".join(info.enums)
    if info.minimum is not None and info.maximum is not None and info.type in ("integer", "float"):
        return f"{info.minimum}..{info.maximum}"
    return ""


def format_table(desc: dict, text: str | None = None) -> str:
    rows = [(i.path, i.type or i.kind, i.access or "-", describe(i))
            for i in walk_descriptor(desc) if not text or text in i.path]
    headings = ("PATH", "TYPE", "ACCESS", "RANGE / VALUES")
    widths = [max(len(r[c]) for r in rows + [headings]) for c in range(3)]
    lines = [f"{r[0]:<{widths[0]}}  {r[1]:<{widths[1]}}  {r[2]:<{widths[2]}}  {r[3]}".rstrip()
             for r in [headings] + rows]
    return "\n".join(lines)


class DescriptorApp:
    """The Part 1 echo app, driven by the descriptor instead of fixed counts.

    It subscribes to whatever buttons, dials, and pages the design exposes,
    and checks each value with validate() before sending it.
    """

    def __init__(self, kp: HControlClient, desc: dict, resend: bool = False):
        self.kp = kp
        self.resend_enabled = resend
        self.desc = desc
        self.params = {info.path: info for info in walk_descriptor(desc)}
        self.lock = threading.Lock()
        self.latest: dict[str, object] = {}     # Newest dial level for each LED ring.
        self.timers: dict[str, threading.Timer] = {}   # Pending resend for each LED ring.
        self.stopped = False

    def stop(self) -> None:
        """Cancel the pending LED ring resends. Call this before you close the client."""
        with self.lock:
            self.stopped = True
            for timer in self.timers.values():
                timer.cancel()
            self.timers.clear()

    def event_paths(self) -> list[str]:
        return [path for path, info in self.params.items()
                if info.kind == "param" and (path.endswith("/action")
                                            or path.endswith("/dial/level")
                                            or path.endswith("/currentpage"))]

    def start(self) -> None:
        for path in self.event_paths():
            fmt = "string" if self.params[path].type == "enum" else None
            self.kp.subscribe(path, self.on_event, fmt=fmt)
            print(f"Subscribed to {path}")

    def on_event(self, path: str, value) -> None:
        print(f"{path} = {value}")
        target, new = self.response_to(path, value)
        if target is None:
            return
        if path.endswith("/dial/level"):
            self.send_ring(target, new)
        else:
            self.send(target, new)

    def send_ring(self, target: str, new) -> None:
        """Send a LED ring level now, and again once the dial has been still."""
        with self.lock:
            if self.stopped:
                return
            self.latest[target] = new
            if self.resend_enabled:
                if target in self.timers:
                    self.timers[target].cancel()
                timer = threading.Timer(RESEND_AFTER, self.resend_ring, (target,))
                timer.daemon = True
                self.timers[target] = timer
                timer.start()
            self.send(target, new)

    def resend_ring(self, target: str) -> None:
        """Send the newest dial level to a LED ring again."""
        with self.lock:
            # Skip this resend if the app stopped or a newer dial event replaced the timer.
            if self.stopped or self.timers.get(target) is not threading.current_thread():
                return
            del self.timers[target]
            try:
                self.send(target, self.latest[target], resend=True)
            except (OSError, HControlError) as error:
                print(f"  Can't write {target}: {error}")

    def send(self, target: str, new, resend: bool = False) -> None:
        """Check a value against the descriptor, then write it."""
        try:
            validate(self.desc, target, new)
        except ValueError as error:
            print(f"  Not sending: {error}")
            return
        self.kp.set(target, new, fmt="string" if self.params[target].type == "enum" else None)
        print(f"  {'resend ' if resend else ''}{target} -> {new}")

    def response_to(self, path: str, value):
        """Decide which parameter to change in response to an event."""
        parent = path.rsplit("/", 1)[0]
        if path.endswith("/action") and value == "PUSH" and f"{parent}/state" in self.params:
            current = self.kp.get(f"{parent}/state", fmt="string")
            return f"{parent}/state", "OFF" if current == "ON" else "ON"
        if path.endswith("/dial/level"):
            page = path.split("/")[1]
            return f"/{page}/ledring/level", value
        return None, None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("command", choices=["download", "list", "run"])
    parser.add_argument("--host", help="keypad IP address (default: discover)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--filter", help="only list paths that contain this text")
    parser.add_argument("-r", "--resend", action="store_true",
                        help="resend the last LED ring level once the dial has been still for 0.6 s")
    parser.add_argument("-v", "--verbose", action="store_true", help="show protocol traffic")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(asctime)s %(message)s")

    host = args.host
    if not host:
        found = [d for d in discover() if str(d.get("model", "")).startswith("OMNI-KP")]
        if not found:
            sys.exit("No keypad found. Use --host to give its IP address.")
        host = found[0]["ip"]

    with HControlClient(host, args.port) as kp:
        desc, cache = download_descriptor(kp)
        if args.command == "download":
            print(f"Saved the descriptor to {cache}")
        elif args.command == "list":
            print(format_table(desc, args.filter))
        else:
            app = DescriptorApp(kp, desc, resend=args.resend)
            try:
                app.start()
                print("Ready. Press buttons or turn the dial. Press Ctrl+C to quit.")
                stop = threading.Event()
                while kp.connected and not stop.wait(0.5):
                    pass
            except KeyboardInterrupt:
                print()
            finally:
                app.stop()


if __name__ == "__main__":
    main()
