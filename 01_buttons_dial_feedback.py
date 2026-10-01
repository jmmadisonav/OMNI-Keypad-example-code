#!/usr/bin/env python3
"""Part 1: React to buttons and the dial, and show feedback on the keypad.

This echo app shows the operations most third-party integrations need:

- Button push: toggles that button between OFF and ON (button feedback).
- Dial turn: copies the dial level to the LED ring on the same page.
- Dial push: moves to the next page.
- Page change: prints the new page, whether you or the app changed it.

The keypad must run a design whose controls aren't bound to an OMNI device;
bound controls aren't available over HControl. To load one, run
`python 03_upload_design.py upload design/`.

Usage:
    python 01_buttons_dial_feedback.py [--host IP] [--resend] [-v]
"""

from __future__ import annotations

import argparse
import logging
import sys
import threading
import time

from hcontrol import DEFAULT_PORT, HControlClient, HControlError, discover

BUTTONS_PER_PAGE = 8

# The LED ring follows every dial event. Writes that close together can
# make the keypad pause dial updates for 500 ms (firmware 1.1.4.0), so
# once the knob has been still for longer than that, send the last level
# again to make sure the ring shows the right value.
# The resend is off by default; turn it on with --resend (-r).
RESEND_AFTER = 0.6


class EchoApp:
    def __init__(self, kp: HControlClient, resend: bool = False):
        self.kp = kp
        self.resend_enabled = resend
        self.pages: list[str] = []
        self.current_page = ""
        self.lock = threading.Lock()
        self.latest: dict[str, int] = {}        # Newest dial level for each LED ring.
        self.timers: dict[str, threading.Timer] = {}   # Pending resend for each LED ring.
        self.stopped = False

    def stop(self) -> None:
        """Cancel the pending LED ring resends. Call this before you close the client."""
        with self.lock:
            self.stopped = True
            for timer in self.timers.values():
                timer.cancel()
            self.timers.clear()

    def start(self) -> None:
        """Read the keypad's pages and subscribe to every control."""
        model = self.kp.get("/configuration/device/model")
        version = self.kp.get("/configuration/device/version")
        print(f"Connected to {model}, firmware {version}")
        if not str(version).startswith("1.1."):
            print("Warning: these examples use firmware 1.1 paths, such as /page1/button1/state.")

        self.pages = self.read_page_names()
        print(f"Pages: {', '.join(self.pages)}")
        self.current_page = self.kp.subscribe(
            "/settings/currentpage", self.on_page, fmt="string")

        for page in range(1, len(self.pages) + 1):
            for button in range(1, BUTTONS_PER_PAGE + 1):
                self.try_subscribe(f"/page{page}/button{button}/action", self.on_button)
            self.try_subscribe(f"/page{page}/dial/level", self.on_dial, fmt=None)
            self.try_subscribe(f"/page{page}/dial_button/action", self.on_dial_push)

    def read_page_names(self) -> list[str]:
        """Read /pages/1/name, /pages/2/name, ... until a page doesn't exist."""
        names = []
        while True:
            try:
                names.append(self.kp.get(f"/pages/{len(names) + 1}/name"))
            except HControlError:
                return names

    def try_subscribe(self, path: str, callback, fmt: str | None = "string") -> None:
        # Enums such as action need fmt="string"; otherwise you get indexes.
        try:
            self.kp.subscribe(path, callback, fmt=fmt)
        except HControlError:
            print(f"  {path} isn't available (bound to OMNI in the design?)")

    # -- Event handlers. Each runs on the client's dispatcher thread. --------

    def on_button(self, path: str, value: str) -> None:
        # path is like /page1/button3/action; value is PUSH or RELEASE.
        print(f"{path} = {value}")
        if value != "PUSH":
            return
        state_path = path.rsplit("/", 1)[0] + "/state"
        current = self.kp.get(state_path, fmt="string")
        new = "OFF" if current == "ON" else "ON"
        self.kp.set(state_path, new, fmt="string")
        print(f"  {state_path} -> {new}")

    def on_dial(self, path: str, value: int) -> None:
        # path is like /page1/dial/level. Copy the level to the LED ring, then
        # resend it once the dial has been still for RESEND_AFTER seconds.
        ring = f"/{path.split('/')[1]}/ledring/level"
        with self.lock:
            if self.stopped:
                return
            self.latest[ring] = value
            if self.resend_enabled:
                if ring in self.timers:
                    self.timers[ring].cancel()
                timer = threading.Timer(RESEND_AFTER, self.resend, (ring,))
                timer.daemon = True
                self.timers[ring] = timer
                timer.start()
            applied = self.kp.set(ring, value)
        print(f"{path} = {value}  (LED ring {applied})")

    def resend(self, ring: str) -> None:
        """Write the newest dial level to a LED ring again."""
        with self.lock:
            # Skip this resend if the app stopped or a newer dial event replaced the timer.
            if self.stopped or self.timers.get(ring) is not threading.current_thread():
                return
            del self.timers[ring]
            try:
                applied = self.kp.set(ring, self.latest[ring])
            except (OSError, HControlError) as error:
                print(f"  Can't write {ring}: {error}")
                return
        print(f"  resend {ring} -> {applied}")

    def on_dial_push(self, path: str, value: str) -> None:
        print(f"{path} = {value}")
        if value != "PUSH":
            return
        index = self.pages.index(self.current_page) if self.current_page in self.pages else -1
        next_page = self.pages[(index + 1) % len(self.pages)]
        self.kp.set("/settings/currentpage", next_page, fmt="string")

    def on_page(self, path: str, value: str) -> None:
        self.current_page = value
        print(f"Page changed to {value}")


def run(host: str, port: int, stop: threading.Event | None = None,
        retry_delay: float = 3, resend: bool = False) -> None:
    """Run the app, reconnecting whenever the connection drops.

    The keypad drops the connection when a new design is deployed, and it
    resets button states and the LED ring, so the app starts over.
    """
    stop = stop or threading.Event()
    while not stop.is_set():
        disconnected = threading.Event()
        try:
            with HControlClient(host, port, on_disconnect=disconnected.set) as kp:
                app = EchoApp(kp, resend)
                try:
                    app.start()
                    print("Ready. Press buttons or turn the dial. Press Ctrl+C to quit.")
                    # Wait in short steps so Ctrl+C works on Windows.
                    while not disconnected.wait(0.5):
                        if stop.is_set():
                            return
                    print("Connection lost.")
                finally:
                    app.stop()    # No LED ring write can follow the close.
        except (OSError, HControlError) as error:   # OSError covers ConnectionError and TimeoutError.
            print(f"Can't talk to {host}: {error}")
        print(f"Reconnecting in {retry_delay:g} seconds...")
        stop.wait(retry_delay)


def find_host() -> str:
    print("Searching for keypads...")
    keypads = [d for d in discover() if str(d.get("model", "")).startswith("OMNI-KP")]
    if not keypads:
        sys.exit("No keypad found. Use --host to give its IP address.")
    for keypad in keypads:
        print(f"  {keypad['ip']}  {keypad.get('model')}  {keypad.get('name')}")
    return keypads[0]["ip"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--host", help="keypad IP address (default: discover)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("-r", "--resend", action="store_true",
                        help="resend the last LED ring level once the dial has been still for 0.6 s")
    parser.add_argument("-v", "--verbose", action="store_true", help="show protocol traffic")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(asctime)s %(message)s")
    try:
        run(args.host or find_host(), args.port, resend=args.resend)
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
