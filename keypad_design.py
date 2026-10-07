"""Read, edit, and write OMNI keypad designs.

A design is the file /project/project.cpio on the keypad. It's an old-style
ASCII cpio archive (magic "070707") that holds:

- keypad.json: pages, buttons, dial, and LED ring settings.
- images/<name>.png: button images that keypad.json refers to by name. They're
  188x188 on the 8BV, and 150x150 on the 6B and 6BV.

This module handles files only. Use hcontrol.HControlClient.get_file() and
put_file() to move designs to and from the keypad.

The keypad.json format isn't publicly documented. This module is based on
designs created by AVX Architect and tested on firmware 1.1.4.0.
"""

from __future__ import annotations

import datetime
import json
import secrets
import struct
import warnings
from pathlib import Path

DESIGN_PATH = "/project/project.cpio"
IMAGE_SIZE = (188, 188)                       # The 8BV's button images.
IMAGE_SIZES = {IMAGE_SIZE, (150, 150)}        # Every model's: the 6B and 6BV use 150x150.

# Firmware 1.1.4.0 can't load a design with more than 9 pages. It accepts
# the upload, then runs with no design at all.
MAX_PAGES = 9

_MAGIC = b"070707"
_HEADER_LEN = 76
_TRAILER = "TRAILER!!!"
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


# -- cpio archives ----------------------------------------------------------------

def unpack_cpio(data: bytes) -> dict[str, bytes]:
    """Return the files in an odc cpio archive as {name: contents}, in order."""
    files: dict[str, bytes] = {}
    pos = 0
    while True:
        header = data[pos:pos + _HEADER_LEN]
        if len(header) < _HEADER_LEN:
            raise ValueError(f"cpio archive is truncated at offset {pos}")
        if header[:6] != _MAGIC:
            raise ValueError(f"not an odc cpio archive: bad magic {header[:6]!r} at offset {pos}")
        name_size = int(header[59:65], 8)
        file_size = int(header[65:76], 8)
        body_start = pos + _HEADER_LEN + name_size
        body_end = body_start + file_size
        if body_end > len(data):
            raise ValueError(f"cpio archive is truncated at offset {pos}")
        name = data[pos + _HEADER_LEN:body_start - 1].decode("utf-8")
        if name == _TRAILER:
            return files
        files[name] = data[body_start:body_end]
        pos = body_end


def pack_cpio(files: dict[str, bytes], mtime: int | None = None) -> bytes:
    """Build an odc cpio archive with the same header layout AVX Architect uses."""
    if mtime is None:
        mtime = int(datetime.datetime.now().timestamp())
    out = bytearray()
    for inode, (name, body) in enumerate(files.items(), start=1):
        out += _header(b"777777", inode, b"100666", mtime, name, len(body))
        out += name.encode("utf-8") + b"\0" + body
    out += _header(b"000000", 0, b"000000", 0, _TRAILER, 0)
    out += _TRAILER.encode("ascii") + b"\0"
    return bytes(out)


def _header(dev: bytes, inode: int, mode: bytes, mtime: int, name: str, size: int) -> bytes:
    return (_MAGIC + dev + b"%06o" % inode + mode
            + b"000000" + b"000000" + b"000001" + b"000000"   # uid, gid, nlink, rdev
            + b"%011o" % mtime + b"%06o" % (len(name.encode("utf-8")) + 1) + b"%011o" % size)


# -- Images -------------------------------------------------------------------------

def png_size(data: bytes) -> tuple[int, int]:
    """Return (width, height) of a PNG, or raise ValueError if it isn't one."""
    if data[:8] != _PNG_SIGNATURE or data[12:16] != b"IHDR":
        raise ValueError("not a PNG file")
    return struct.unpack(">II", data[16:24])


# -- Designs --------------------------------------------------------------------------

class Design:
    """A keypad design: the parsed keypad.json plus its images.

    Pages and buttons are numbered from 1, the same as on the keypad.
    """

    def __init__(self, config: dict, images: dict[str, bytes] | None = None,
                 extra: dict[str, bytes] | None = None):
        self.config = config
        self.images = dict(images or {})    # file name -> PNG bytes
        self.extra = dict(extra or {})      # any other archive members, kept as-is

    # -- Loading and saving -----------------------------------------------------

    @classmethod
    def from_cpio(cls, data: bytes) -> Design:
        files = unpack_cpio(data)
        if "keypad.json" not in files:
            raise ValueError("archive has no keypad.json")
        config = json.loads(files.pop("keypad.json"))
        images = {name[len("images/"):]: body for name, body in files.items()
                  if name.startswith("images/")}
        extra = {name: body for name, body in files.items() if not name.startswith("images/")}
        return cls(config, images, extra)

    @classmethod
    def load(cls, folder: str | Path) -> Design:
        folder = Path(folder)
        config = json.loads((folder / "keypad.json").read_text(encoding="utf-8"))
        image_dir = folder / "images"
        images = {}
        if image_dir.is_dir():
            images = {p.name: p.read_bytes() for p in sorted(image_dir.glob("*.png"))}
        return cls(config, images)

    def save(self, folder: str | Path) -> None:
        folder = Path(folder)
        (folder / "images").mkdir(parents=True, exist_ok=True)
        (folder / "keypad.json").write_text(
            json.dumps(self.config, indent=2) + "\n", encoding="utf-8")
        for name, body in self.images.items():
            (folder / "images" / name).write_bytes(body)

    def to_cpio(self, now: datetime.datetime | None = None) -> bytes:
        """Pack the design for upload.

        Sets a new random fingerprint and a deployment timestamp. The keypad
        reports the fingerprint at /configuration/device/fingerprint once the
        design is running. Refuses designs with more than MAX_PAGES pages or
        with missing images.
        """
        if len(self.pages) > MAX_PAGES:
            raise ValueError(f"the design has {len(self.pages)} pages; "
                             f"the keypad can load at most {MAX_PAGES}")
        missing = self.missing_images()
        if missing:
            raise ValueError(f"keypad.json refers to images that aren't in the design: "
                             f"{', '.join(missing)}")
        now = now or datetime.datetime.now()
        self.config["fingerprint"] = secrets.token_hex(16)
        self.config["lastdeployedtimestamp"] = _architect_timestamp(now)
        files = {"keypad.json": json.dumps(self.config, separators=(",", ":")).encode("utf-8")}
        files.update({f"images/{name}": body for name, body in self.images.items()})
        files.update(self.extra)
        return pack_cpio(files, int(now.timestamp()))

    @property
    def fingerprint(self) -> str:
        return self.config.get("fingerprint", "")

    # -- Editing ---------------------------------------------------------------------

    @property
    def pages(self) -> list[dict]:
        return self.config["pages"]

    def page(self, page: int) -> dict:
        if not 1 <= page <= len(self.pages):
            raise IndexError(f"page {page} doesn't exist; the design has {len(self.pages)} pages")
        return self.pages[page - 1]

    def button(self, page: int, button: int) -> dict:
        buttons = self.page(page)["buttons"]
        if not 1 <= button <= len(buttons):
            raise IndexError(f"button {button} doesn't exist; page {page} has {len(buttons)} buttons")
        return buttons[button - 1]

    def set_button_images(self, page: int, button: int, off: str | Path | None = None,
                          on: str | Path | None = None, alt: str | Path | None = None) -> None:
        """Use the given PNG files for a button's OFF, ON, and Alt states."""
        target = self.button(page, button)
        for key, source in (("offImage", off), ("onImage", on), ("altImage", alt)):
            if source is None:
                continue
            source = Path(source)
            data = source.read_bytes()
            size = png_size(data)
            if size not in IMAGE_SIZES:
                warnings.warn(f"{source.name} is {size[0]}x{size[1]}; keypad buttons are "
                              "188x188 on the 8BV and 150x150 on the 6B and 6BV")
            self.images[source.name] = data
            target[key] = [source.name]

    def unbind_all(self) -> None:
        """Remove every OMNI binding so all controls are available over HControl."""
        for page in self.pages:
            controls = [page.get("ledring"), page.get("dial"), page.get("dial_button")]
            for control in controls + page.get("buttons", []):
                if not control:
                    continue
                control["remote"] = ""
                control["path"] = ""
                if "destination" in control:
                    control["destination"] = ""

    def set_dial_range(self, page: int, minimum: float, maximum: float) -> None:
        """Set the value range of a page's dial and LED ring."""
        target = self.page(page)
        for key in ("dial", "ledring"):
            target[key]["min"] = float(minimum)
            target[key]["max"] = float(maximum)

    def referenced_images(self) -> set[str]:
        """Return the names of every image a button refers to."""
        used = set()
        for page in self.pages:
            for button in page.get("buttons", []):
                for key in ("offImage", "onImage", "altImage"):
                    used.update(button.get(key) or [])
        return used

    def missing_images(self) -> list[str]:
        """Return referenced image names that aren't in the design, sorted."""
        return sorted(self.referenced_images() - set(self.images))

    def prune_images(self) -> None:
        """Remove images that no button refers to."""
        used = self.referenced_images()
        self.images = {name: body for name, body in self.images.items() if name in used}


def _architect_timestamp(now: datetime.datetime) -> str:
    """Format a time the way AVX Architect does, for example 18/08/2026 1:21:08 AM."""
    hour = now.hour % 12 or 12
    suffix = "AM" if now.hour < 12 else "PM"
    return f"{now.day}/{now.month:02d}/{now.year} {hour}:{now.minute:02d}:{now.second:02d} {suffix}"
