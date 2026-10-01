#!/usr/bin/env python3
"""Part 3 (experimental): Back up, change, and upload keypad designs.

You normally create designs in AVX Architect (a beta release; request it
from HARMAN). This script shows how to do the same over HControl: a design is
the file /project/project.cpio on the keypad, and uploading a new one
redeploys the keypad. There's no way to change a single image; every change
uploads the whole design.

Every command that writes to the keypad saves a backup first.

Usage:
    python 03_upload_design.py backup [FILE.cpio]
    python 03_upload_design.py upload FOLDER
    python 03_upload_design.py restore FILE.cpio
    python 03_upload_design.py set-image --page P --button B [--off PNG] [--on PNG] [--alt PNG]
    python 03_upload_design.py make-third-party

Add --host IP to any command to skip discovery.
"""

from __future__ import annotations

import argparse
import datetime
import logging
import sys
import time
from pathlib import Path

from hcontrol import DEFAULT_PORT, HControlClient, HControlError, discover
from keypad_design import DESIGN_PATH, Design


def backup(kp: HControlClient, target: Path | None = None) -> Path:
    """Download the running design to a .cpio file and an unpacked folder."""
    data = kp.get_file(DESIGN_PATH)
    if target is None:
        target = Path(f"backup_{datetime.datetime.now():%Y%m%d_%H%M%S}.cpio")
    target.write_bytes(data)
    Design.from_cpio(data).save(target.with_suffix(""))
    print(f"Backed up the current design to {target}")
    return target


def upload(kp: HControlClient, data: bytes) -> None:
    """Upload a packed design. The keypad then redeploys and drops the connection."""
    print(f"Uploading {len(data):,} bytes...")
    kp.put_file(DESIGN_PATH, data)


def wait_for_design(host: str, port: int, fingerprint: str, timeout: float = 90) -> None:
    """Reconnect until the keypad reports the new design's fingerprint.

    Redeploying resets button states, the LED ring, and the current page,
    so apps must set their feedback again after they reconnect.
    """
    print("Waiting for the keypad to restart with the new design...")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with HControlClient(host, port, timeout=3) as kp:
                if kp.get("/configuration/device/fingerprint", fmt="string") == fingerprint:
                    page = kp.get("/settings/currentpage", fmt="string")
                    print(f"The keypad is running the new design (current page: {page}).")
                    return
        except (OSError, HControlError):
            pass          # Still restarting: refused, reset, timed out, or not ready.
        time.sleep(2)
    raise TimeoutError("the keypad didn't report the new design's fingerprint in time")


def deploy(host: str, port: int, design: Design | None = None,
           data: bytes | None = None) -> Path:
    """Back up the current design, upload a new one, and wait until it runs.

    Pass either a Design (which gets a new fingerprint) or packed data from
    a backup file. Return the path of the backup of the design that was running
    before, so you can restore it.
    """
    if design is not None:
        data = design.to_cpio()          # Sets a new fingerprint.
        fingerprint = design.fingerprint
    elif data is not None:
        fingerprint = Design.from_cpio(data).fingerprint
    else:
        raise ValueError("deploy() needs a design or packed data")
    # Transfers are slow; allow more time per reply than the default.
    with HControlClient(host, port, timeout=15) as kp:
        backup_path = backup(kp)
        upload(kp, data)
    wait_for_design(host, port, fingerprint)
    return backup_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--host", help="keypad IP address (default: discover)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("-v", "--verbose", action="store_true", help="show protocol traffic")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("backup").add_argument("file", nargs="?", type=Path)
    commands.add_parser("upload").add_argument("folder", type=Path)
    commands.add_parser("restore").add_argument("file", type=Path)
    image = commands.add_parser("set-image")
    image.add_argument("--page", type=int, required=True)
    image.add_argument("--button", type=int, required=True)
    image.add_argument("--off", type=Path)
    image.add_argument("--on", type=Path)
    image.add_argument("--alt", type=Path)
    commands.add_parser("make-third-party")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING,
                        format="%(asctime)s %(message)s")

    host = args.host
    if not host:
        found = [d for d in discover() if str(d.get("model", "")).startswith("OMNI-KP")]
        if not found:
            sys.exit("No keypad found. Use --host to give its IP address.")
        host = found[0]["ip"]

    if args.command == "set-image" and not (args.off or args.on or args.alt):
        sys.exit("Give at least one of --off, --on, or --alt.")

    if args.command == "upload":
        deploy(host, args.port, design=Design.load(args.folder))
    elif args.command == "restore":
        deploy(host, args.port, data=args.file.read_bytes())
    else:
        with HControlClient(host, args.port, timeout=15) as kp:
            if args.command == "backup":
                backup(kp, args.file)
                return
            design = Design.from_cpio(kp.get_file(DESIGN_PATH))
        if args.command == "set-image":
            design.set_button_images(args.page, args.button, args.off, args.on, args.alt)
            design.prune_images()
        else:  # make-third-party
            design.unbind_all()
        deploy(host, args.port, design=design)


if __name__ == "__main__":
    main()
