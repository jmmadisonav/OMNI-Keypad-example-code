# Control a BSS OMNI keypad over HControl

These examples show you how to use a BSS OMNI keypad (OMNI-KP-8BV) as a
control surface for your own software, without an OMNI core. You use the
HControl protocol to receive button presses and dial movement, change pages,
show button and LED ring feedback, read the keypad's descriptor, and upload
designs and button images.

The examples are written in Python and use only the standard library.

| Part | Script | What you learn |
|---|---|---|
| 0 | `00_raw_protocol.py` | See exactly what goes on the wire: one script, no helper module. Start here. |
| 1 | `01_buttons_dial_feedback.py` | Receive button and dial events, change pages, and show feedback. |
| 2 | `02_descriptor.py` | Download the descriptor and use it to find the paths your design exposes. |
| 3 | `03_upload_design.py` | Back up, change, and upload designs and button images. *Experimental.* |

Parts 1 to 3 use the shared helper `hcontrol.py`, which handles the
connection. Part 0 doesn't use it. `keypad_design.py` reads and writes design
files. You can copy both modules into your own project.

## Before you begin

To run the examples, you need the following:

- Python 3.10 or later.
- An OMNI keypad on your network, running firmware 1.1.x. The examples were
  tested on firmware 1.1.4.0.
- A design on the keypad whose controls **aren't bound to an OMNI device**.
  The keypad only exposes unbound controls over HControl. The `design/`
  folder contains a ready-to-use design.

You normally create keypad designs, including button images and
assignments, in AVX Architect. AVX Architect is currently a beta release, and
you need to request it from HARMAN. If you don't have AVX Architect, you can
load the design in `design/` with Part 3 of these examples.

## Find your keypad

To find keypads on your network, run:

```
python -c "import hcontrol; print(*hcontrol.discover(), sep='\n')"
```

The output has one line for each device. Each line is a Python dict that
includes the device's `ip`, `model`, `name`, and `version`, among other
fields. Parts 1 to 3 also run discovery when you leave out `--host`.

## Load the third-party design

The examples need a design where every button, the dial, and the LED ring are
unbound. To load the included design, run:

```
python 03_upload_design.py --host 172.17.0.46 upload design/
```

Replace `172.17.0.46` with your keypad's IP address. The script backs up the
current design to `backup_<date>_<time>.cpio`, uploads the new design, and
waits about 20 seconds for the keypad to restart with it.

To load it from AVX Architect instead, create a design with no OMNI
assignments on any control, and deploy it to the keypad.

`design_no_borders/` is the same design with no colored separator lines between the buttons. To load it, run:

```
python 03_upload_design.py --host 172.17.0.46 upload design_no_borders/
```

The separator color is a design setting called `panel_separator_color` in `keypad.json`. You can change it at run time by setting `/pages/N/panel_separator_color`, but the next design deployment resets it.

## Part 0: The raw protocol

`00_raw_protocol.py` is a single standard-library script that prints every
line it sends (`->`) and receives (`<-`), so you can write your own client in
any language. To run it, enter:

```
python 00_raw_protocol.py 172.17.0.46
```

This trace is an excerpt from a real session, with `...` where lines are
cut. The script reads a page name, subscribes to the dial, and then reacts
when you turn the dial:

```
-> get {"path":"/pages/1/name"}
<- @get {"path":"/pages/1/name","value":"Page 1"}
...
-> subscribe {"path":"/page1/dial/level"}
<- @subscribe {"path":"/page1/dial/level","value":0}
...
Ready. Press buttons or turn the dial. Press Ctrl+C to quit.
<- publish {"path":"/page1/dial/level","format":"variant","value":40}
-> @publish {"path":"/page1/dial/level","format":"variant","value":40}
-> set {"path":"/page1/ledring/level","value":40}
<- @set {"path":"/page1/ledring/level","value":40}
```

In the trace, note the following:

- Every request gets one reply that starts with `@`, so send one request at a
  time.
- Subscribe with `"format":"string"` so enums arrive as names, such as
  `RELEASE`.
- The keypad sends `publish` when a control changes. You must send it back
  with an `@` in front before the keypad sends the next one.
- A `publish` can arrive before the reply to your own request.

Part 1 builds the same app on `hcontrol.py`, which handles these rules for
you.

## Part 1: Buttons, dial, and feedback

`01_buttons_dial_feedback.py` is an echo app that reacts to the keypad:

- When you push a button, it toggles that button between OFF and ON.
- When you turn the dial, it moves the LED ring to the same level.
- When you push the dial, it moves to the next page.
- When the page changes, it prints the new page name.

To run it, enter:

```
python 01_buttons_dial_feedback.py --host 172.17.0.46
```

To see the same protocol lines as Part 0, each with a timestamp in front, add
`-v`.

```
python 01_buttons_dial_feedback.py --host 172.17.0.46 -v
```

### How it works

The app subscribes to each control's path. When a control changes, the
keypad sends a `publish` message, and `hcontrol.py` calls your callback:

```python
from hcontrol import HControlClient

def on_button(path, value):
    print(path, value)            # /page1/button3/action PUSH

with HControlClient("172.17.0.46") as kp:
    kp.subscribe("/page1/button3/action", on_button, fmt="string")
    kp.set("/page1/button3/state", "ON", fmt="string")          # button feedback
    kp.set("/page1/ledring/level", 5)                            # LED ring
    kp.set("/settings/currentpage", "Page 2", fmt="string")      # change page
```

Callbacks run on a background thread, and they can call `get()` and `set()`.

### Paths

These are the paths for firmware 1.1.x. Pages and buttons are numbered from 1.

| Path | Access | Values |
|---|---|---|
| `/pageN/buttonM/action` | read | `RELEASE`, `PUSH` |
| `/pageN/buttonM/state` | read and write | `OFF`, `Alt`, `ON` (`Alt` looks different from both, even without an Alt image) |
| `/pageN/buttonM/enabled` | read and write | `true`, `false` |
| `/pageN/dial/level` | read and write | The design's dial range |
| `/pageN/dial_button/action` | read | `RELEASE`, `PUSH` |
| `/pageN/ledring/level` | read and write | The design's dial range |
| `/pageN/ledring/ledmode` | read and write | `NORMAL`, `MODE1`, `MODE2`, `MODE3`, `DISCO` (`MODE2` showed no visible change on firmware 1.1.4.0) |
| `/pages/N/name` | read | Page name |
| `/pages/N/background` | read and write | Color, such as `#003366` |
| `/settings/currentpage` | read and write | Page name |
| `/settings/brightness` | read and write | 0 to 100 |

Keep these rules in mind:

- **Enums:** Pass `fmt="string"` to read and write enums by name. Without it,
  the keypad uses indexes, for example `2` for `ON`.
- **Ranges:** The keypad clamps numbers to the range set in the design.
  `set()` returns the value the keypad applied.
- **Redeploying:** When a new design is deployed, the keypad drops every
  connection and resets button states, the LED ring, and the current page. The
  app reconnects and starts over.

## Part 2: Descriptor

The descriptor is a JSON file that lists every parameter and command the
keypad exposes for its current design. Because it changes with the design, use
it to find paths instead of hard-coding them.

To download the descriptor, run:

```
python 02_descriptor.py --host 172.17.0.46 download
```

The file is saved as `descriptor_<fingerprint>.json`. The fingerprint changes
with every design upload, so the script downloads the descriptor again only
when the design changes.

To list every path, with its type and allowed values, run:

```
python 02_descriptor.py --host 172.17.0.46 list --filter page1/
```

The output includes lines like these:

```
PATH                        TYPE     ACCESS  RANGE / VALUES
/page1/ledring/ledmode      enum     rw      NORMAL | MODE1 | MODE2 | MODE3 | DISCO
/page1/ledring/level        integer  rw      0..100
/page1/button1/state        enum     rw      OFF | Alt | ON
/page1/button1/action       enum     ro      RELEASE | PUSH
```

You can paste any path from this list into `get()`, `set()`, or
`subscribe()`.

To run the Part 1 echo app driven by the descriptor, run:

```
python 02_descriptor.py --host 172.17.0.46 run
```

This version finds the buttons, dials, and pages in the descriptor, so it
works with any design. Before each `set()`, it calls `validate()`, which
reports values that are out of range or not allowed:

```python
from hcontrol import validate

validate(desc, "/page1/ledring/level", 500)
# ValueError: /page1/ledring/level value 500 is above the maximum of 100
```

## Part 3: Designs and images (experimental)

A design is the file `/project/project.cpio` on the keypad. It contains
`keypad.json`, which describes the pages and controls, and an `images/` folder
of 188x188 PNG button images. You can download it, change it, and upload it
again.

> **Note:** The design format and file transfer commands aren't publicly
> documented. This part is based on AVX Architect's network traffic and was
> tested on firmware 1.1.4.0. Every command that writes to the keypad makes a
> backup first.

| To | Run |
|---|---|
| Back up the current design | `python 03_upload_design.py backup` |
| Upload a design folder | `python 03_upload_design.py upload design/` |
| Restore a backup | `python 03_upload_design.py restore backup_20261001_092048.cpio` |
| Change one button's images | `python 03_upload_design.py set-image --page 1 --button 3 --off Mute_OFF.png --on Mute_ON.png` |
| Remove all OMNI bindings | `python 03_upload_design.py make-third-party` |

Add `--host` with your keypad's IP address to any command.

The keypad has no command to change a single image. `set-image` downloads the
whole design, changes it, and uploads it again, which restarts the keypad.

A design can have at most 9 pages on firmware 1.1.4.0. If you upload a design
with more, the keypad accepts the file but can't load it, and runs with no
design until you restore one. `keypad_design.py` refuses to pack a design with
more than 9 pages.

To change a design in your own code, use `keypad_design.Design`:

```python
from keypad_design import Design

design = Design.load("design")
design.set_button_images(1, 3, off="Mute_OFF.png", on="Mute_ON.png")
design.set_dial_range(1, 0, 100)
data = design.to_cpio()               # new fingerprint and timestamp
```

## Protocol reference

HControl is a line-based protocol on TCP port 4197. Each message is a command,
a space, a JSON object, and a line feed. Replies start with `@`. For the
documented commands (`get`, `set`, `subscribe`, `unsubscribe`, `exec`), see
the [*Harman HControl Protocol Quick Start Guide*](docs/Harman%20HControl%20Protocolv1.23.0.0.pdf)
in `docs/`.

This is a typical exchange. Lines starting with `->` are sent to the keypad:

```
-> subscribe {"path":"/page1/dial/level"}
<- @subscribe {"path":"/page1/dial/level","value":0}
-> set {"path":"/page1/dial/level","value":-50}
<- publish {"path":"/page1/dial/level","format":"variant","value":-50}
-> @publish {"path":"/page1/dial/level","format":"variant","value":-50}
<- @set {"path":"/page1/dial/level","value":-50}
```

A `publish` can arrive before the reply to your request, and the keypad
doesn't send the next `publish` until you acknowledge the current one with
`@publish`. `hcontrol.py` handles both.

Part 0 always prints this traffic. For Parts 1 to 3, add `-v`.

### Messages not in the Quick Start Guide

**Discovery.** Send this as a UDP broadcast to port 4197. Each device answers
with `@disco` and the requested fields, sent to `replyport`:

```
disco {"replyport":54197,"params":["ip","model","name","guid","version"]}
```

**Download a file.** The keypad sends base64 blocks. Acknowledge each one, and
reply to the final empty block:

```
-> getfile {"blocksize":65536,"path":"descriptor/hornet.json","state":"begin"}
<- @getfile {"blocksize":1000,"length":28139}
<- block {"blockno":1,"data":"ewoJIi5raW5k..."}
-> @block {"blockno":1}
   ...
<- block {}
-> @block {}
-> getfile {"length":28139,"state":"end"}
<- @getfile {}
```

**Upload a file.** The keypad sets the block size, in base64 characters.
Finish with the MD5 checksum of the raw file:

```
-> putfile {"blocksize":65536,"length":4209,"path":"/project/project.cpio","state":"begin"}
<- @putfile {"blocksize":1000}
-> block {"blockno":1,"data":"MDcwNzA3Nzc3..."}
<- @block {"blockno":1}
   ...
-> putfile {"checksum":"6f8541dbfa82cf0de1fcb89a9d012af2","length":4209,"state":"end"}
<- @putfile {}
```

### Firmware differences

Firmware 1.0.x used different paths. For example, the dial was
`/pages/1/dial` and button states were `/pages/1/buttons/1/output`.
`docs/OMNI_dynamic_keypad.json` is a firmware 1.0 descriptor that uses those
paths. On firmware 1.1.x, use the paths in this README, or list them with
`02_descriptor.py`.

## Troubleshooting

**A path returns `unknown path`.**
The control is probably bound to an OMNI device in the design, or you're
using firmware 1.0 paths. List the available paths with
`python 02_descriptor.py list`.

**Enum values come back as numbers.**
Pass `fmt="string"` to `get()`, `set()`, and `subscribe()`.

**The LED ring doesn't go past a certain value.**
The keypad clamps values to the dial range in the design. Check the range with
`python 02_descriptor.py list --filter ledring`.

**The connection drops.**
The keypad drops connections when a design is deployed. Reconnect and
subscribe again, as `01_buttons_dial_feedback.py` does.

**Discovery finds nothing.**
Your computer might have several network adapters, or a firewall might block
UDP. Pass `--host` with the keypad's IP address instead.

## Run the tests

To run the unit tests, which use a fake keypad and don't need hardware, run:

```
python -m unittest discover -s tests -t .
```

To check the examples against a real keypad, set `KEYPAD_HOST` and run the
hardware check. It asks you to press buttons and look at the screen, and it
redeploys the design once.

```
$env:KEYPAD_HOST = "172.17.0.46"
python tests/hardware_check.py
```
