#!/usr/bin/env python3
"""Check the examples against a real keypad.

This script isn't part of the unit tests. It needs a keypad running the
third-party design in design/, and a person to press buttons and look at the
screen. It redeploys the design twice, once with a backup and once with a
restore of that backup, which resets button states.

Usage:
    set KEYPAD_HOST=172.17.0.46        (PowerShell: $env:KEYPAD_HOST = "...")
    python tests/hardware_check.py
"""

from __future__ import annotations

import importlib
import json
import os
import queue
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hcontrol import DEFAULT_PORT, HControlClient, HControlError, validate  # noqa: E402
from keypad_design import DESIGN_PATH, Design  # noqa: E402

HOST = os.environ.get("KEYPAD_HOST")
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))


def ask(question: str) -> bool:
    return input(f"{question} [y/n] ").strip().lower().startswith("y")


def wait_event(events: queue.Queue, path: str, timeout: float = 30):
    while True:
        try:
            got_path, value = events.get(timeout=timeout)
        except queue.Empty:
            return None
        if got_path == path:
            return value


def main() -> None:
    if not HOST:
        sys.exit("Set KEYPAD_HOST to the keypad's IP address to run the hardware check.")

    with HControlClient(HOST) as kp:
        version = kp.get("/configuration/device/version")
        original = kp.get("/configuration/device/fingerprint", fmt="string")
        check("firmware is 1.1.x", str(version).startswith("1.1."), str(version))

        location = kp.get("/configuration/device/descriptorlocation", fmt="string")
        desc = json.loads(kp.get_file(location))
        check("descriptor downloads and parses", "settings" in desc, location)

        check("set returns applied value",
              kp.set("/page1/button1/state", "ON", fmt="string") == "ON")
        check("numbers are clamped to the design range",
              kp.set("/page1/ledring/level", 500) == 100)
        try:
            validate(desc, "/page1/ledring/level", 500)
            check("validate rejects out-of-range value", False)
        except ValueError as error:
            check("validate rejects out-of-range value", True, str(error))
        try:
            kp.get("/nonexistent")
            check("unknown path raises HControlError", False)
        except HControlError as error:
            check("unknown path raises HControlError", error.message == "unknown path", error.message)

        events: queue.Queue = queue.Queue()
        record = lambda path, value: events.put((path, value))  # noqa: E731
        kp.set("/settings/currentpage", "Page 1", fmt="string")
        kp.set("/page1/button2/state", "OFF", fmt="string")
        kp.subscribe("/page1/button2/action", record, fmt="string")
        kp.subscribe("/page1/dial/level", record)
        kp.subscribe("/page1/dial_button/action", record, fmt="string")

        print("\nPress and release button 2 on page 1.")
        check("button push is published", wait_event(events, "/page1/button2/action") == "PUSH")
        check("momentary button doesn't change its own state",
              kp.get("/page1/button2/state", fmt="string") == "OFF")
        print("Turn the dial.")
        check("dial turn is published", wait_event(events, "/page1/dial/level") is not None)
        print("Push the dial.")
        check("dial push is published", wait_event(events, "/page1/dial_button/action") == "PUSH")

        kp.set("/page1/button1/state", "ON", fmt="string")
        check("ON image shows", ask("Does button 1 show its ON image?"))
        kp.set("/page1/button1/state", "Alt", fmt="string")
        alt = ask("With state Alt, does button 1 look different from ON and OFF?")
        check("Alt state observed", True, "visible change" if alt else "no visible change")
        for mode in ("MODE1", "MODE2", "MODE3", "DISCO", "NORMAL"):
            kp.set("/page1/ledring/ledmode", mode, fmt="string")
            seen = ask(f"LED ring mode {mode}: does the ring look different?")
            check(f"ledmode {mode} observed", True, "visible" if seen else "no visible change")

        design = Design.from_cpio(kp.get_file(DESIGN_PATH))
        check("design downloads", len(design.pages) >= 1, f"{len(design.pages)} pages")

    print("\nRedeploying the same design (about 20 seconds)...")
    upload = importlib.import_module("03_upload_design")
    backup_path = upload.deploy(HOST, DEFAULT_PORT, design=design)
    with HControlClient(HOST) as kp:
        check("redeploy runs new fingerprint",
              kp.get("/configuration/device/fingerprint", fmt="string") == design.fingerprint)
        check("redeploy resets button state",
              kp.get("/page1/button1/state", fmt="string") == "OFF")

    print("\nRestoring the original design (about 20 seconds)...")
    upload.deploy(HOST, DEFAULT_PORT, data=backup_path.read_bytes())
    with HControlClient(HOST) as kp:
        check("restore returns the original design",
              kp.get("/configuration/device/fingerprint", fmt="string") == original)

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
