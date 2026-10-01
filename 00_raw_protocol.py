#!/usr/bin/env python3
"""Part 0: Talk to the keypad with plain sockets and see every line on the wire.

This script uses only the standard library, so you can copy the protocol into
any language. It prints every line it sends (`->`) and receives (`<-`).

The protocol is lines of text over TCP port 4197. Each line is a command
name, a space, and a JSON object, such as `get {"path":"/pages/1/name"}`.
The keypad answers with the same command prefixed by `@`, such as `@get {...}`.
If a request fails, the reply contains an "error" field.

Send one request at a time and wait for its reply before you send the next.
When a value you subscribed to changes, the keypad sends a `publish` line. You
must acknowledge each `publish` by sending the same line back with an `@`
prefix. The keypad sends no further `publish` until you do.

The script copies every dial level to the LED ring right away. To resend the
last LED ring level once the dial has been still for 0.6 seconds, add
`--resend` (or `-r`).

Usage:
    python 00_raw_protocol.py KEYPAD_IP [--resend]
"""

import json
import select
import socket
import sys
import time

PORT = 4197

# Send the last level again to make sure the ring shows the right value.
# The resend is off by default; turn it on with --resend (-r).
RESEND_AFTER = 0.6

# Bytes received from the keypad that don't yet make up a whole line.
buffer = b""


def send(sock, command, params=None):
    """Send one command line, such as `get {"path":"/pages/1/name"}`."""
    line = command
    if params is not None:
        line += " " + json.dumps(params, separators=(",", ":"))
    print("-> " + line)
    sock.sendall(line.encode("utf-8") + b"\n")


def read_line(sock, timeout=None):
    """Read one line from the keypad.

    Return the line, "" if nothing arrives within `timeout` seconds, or None
    when the connection closes. Without a timeout, wait as long as it takes.
    """
    global buffer
    while True:
        while b"\n" not in buffer:
            if timeout is not None and not select.select([sock], [], [], timeout)[0]:
                return ""
            chunk = sock.recv(4096)
            if not chunk:
                return None
            buffer += chunk
        raw, _, buffer = buffer.partition(b"\n")
        line = raw.decode("utf-8").strip("\r")
        if line:
            print("<- " + line)
            return line


def parse(line):
    """Split `@set {"path":"/x"}` into ("@set", {"path": "/x"})."""
    command, _, body = line.partition(" ")
    return command, (json.loads(body) if body.strip() else {})


def acknowledge(sock, line):
    """Acknowledge a publish by sending the same line back with an `@` prefix."""
    text = "@" + line
    print("-> " + text)
    sock.sendall(text.encode("utf-8") + b"\n")


def request(sock, command, params, events):
    """Send a command and return the parsed reply, which may have an "error".

    A publish can arrive before the reply. Acknowledge it right away and save
    it in `events` to handle later.
    """
    send(sock, command, params)
    while True:
        line = read_line(sock)
        if line is None:
            raise ConnectionError("the keypad closed the connection")
        name, body = parse(line)
        if name == "publish":
            acknowledge(sock, line)
            events.append(body)
        elif name == "@" + command:
            return body


def handle(sock, event, pages, current_page, events, resend):
    """React to one published change. Return the (possibly new) current page."""
    path, value = event["path"], event.get("value")
    if path.endswith("/action") and "/button" in path:
        if value == "PUSH":
            # Toggle the button's light: read its state, then write the opposite.
            state_path = path[:-len("action")] + "state"
            state = request(sock, "get",
                            {"path": state_path, "format": "string"}, events)
            new = "OFF" if state.get("value") == "ON" else "ON"
            request(sock, "set",
                    {"path": state_path, "format": "string", "value": new}, events)
    elif path.endswith("/dial/level"):
        # Copy the dial level to the LED ring on the same page, then note the
        # level and the time so the main loop can resend it after the dial stops.
        ring_path = f"/{path.split('/')[1]}/ledring/level"
        request(sock, "set", {"path": ring_path, "value": value}, events)
        if resend is not None:
            resend[ring_path] = (value, time.monotonic())
    elif path.endswith("/dial_button/action"):
        if value == "PUSH":
            # Move to the next page, wrapping around after the last one.
            index = pages.index(current_page) if current_page in pages else -1
            request(sock, "set",
                    {"path": "/settings/currentpage", "format": "string",
                     "value": pages[(index + 1) % len(pages)]}, events)
    elif path == "/settings/currentpage":
        current_page = value
    return current_page


def run(host, port=PORT, resend=False):
    """Connect, subscribe to the controls, and react to changes.

    If `resend` is True, write the LED ring again after the dial stops.
    """
    # Step 1: Open a TCP connection. Lines are UTF-8 text ending in a newline.
    global buffer
    buffer = b""
    with socket.create_connection((host, port), timeout=5) as sock:
        sock.settimeout(None)
        print(f"Connected to {host}:{port}")
        events = []

        # Step 2: `get` reads a value. An error reply means the page doesn't exist.
        pages = []
        while True:
            reply = request(sock, "get",
                            {"path": f"/pages/{len(pages) + 1}/name"}, events)
            if "error" in reply:
                break
            pages.append(reply["value"])

        # Step 3: `subscribe` asks for a publish whenever a value changes.
        # Use "format":"string" to get enum names, such as PUSH, not numbers.
        paths = [("/settings/currentpage", "string")]
        for page in range(1, len(pages) + 1):
            for button in range(1, 9):
                paths.append((f"/page{page}/button{button}/action", "string"))
            paths.append((f"/page{page}/dial/level", ""))  # a number, so no format
            paths.append((f"/page{page}/dial_button/action", "string"))
        current_page = ""
        for path, fmt in paths:
            params = {"path": path}
            if fmt:
                params["format"] = fmt
            reply = request(sock, "subscribe", params, events)
            if "error" in reply:
                # Buttons bound to an OMNI device aren't available.
                print(f"   (skipping {path}: {reply['error']})")
            elif path == "/settings/currentpage":
                current_page = reply["value"]

        # Step 4: Wait for publishes. Acknowledge each one, then react to it.
        # Each dial turn writes the LED ring and adds the level to `pending`.
        # While `pending` has entries, the loop wakes up every 0.1 seconds to
        # check whether the dial has been still long enough to write it again.
        print("Ready. Press buttons or turn the dial. Press Ctrl+C to quit.")
        pending = {}
        while True:
            event = None
            if events:
                event = events.pop(0)
            else:
                line = read_line(sock, 0.1 if pending else None)
                if line is None:
                    print("Connection closed by the keypad.")
                    return
                if line:
                    name, body = parse(line)
                    if name == "publish":
                        acknowledge(sock, line)
                        event = body
            if event is not None:
                current_page = handle(sock, event, pages, current_page,
                                      events, pending if resend else None)
            for ring_path, (value, turned) in list(pending.items()):
                if time.monotonic() - turned >= RESEND_AFTER:
                    request(sock, "set", {"path": ring_path, "value": value}, events)
                    del pending[ring_path]


def main():
    hosts = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    if not hosts:
        print("Usage: python 00_raw_protocol.py KEYPAD_IP [--resend]")
        sys.exit(2)
    resend = "--resend" in sys.argv or "-r" in sys.argv
    try:
        run(hosts[0], resend=resend)
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
