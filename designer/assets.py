"""Read the base shapes and ready-made buttons in docs/Keypad Graphics.zip.

Shapes live in one folder per set, such as Squared/Squared_Aqua_OFF.png. A
colour with a single file, such as Squared_Black.png, looks the same in both
states. Pairs of files at the top level, such as HDMI_Squared_OFF.png and
HDMI_Squared_ON.png, are ready-made buttons.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

ZIP_PATH = Path(__file__).resolve().parent.parent / "docs" / "Keypad Graphics.zip"

_ROOT = "Keypad Graphics/"
_SPELLING = {"Megenta": "Magenta"}     # Squared_Megenta_ON.png in the zip.


class GraphicsZip:
    """The PNG files in the graphics zip, by name without the root folder."""

    def __init__(self, path: str | Path = ZIP_PATH):
        self.path = Path(path)
        with zipfile.ZipFile(self.path) as archive:
            self._names = sorted(
                member[len(_ROOT):] for member in archive.namelist()
                if member.startswith(_ROOT) and member.lower().endswith(".png"))

    def catalog(self) -> dict:
        shapes: dict[str, dict[str, dict[str, str]]] = {}
        buttons: dict[str, dict[str, str]] = {}
        for name in self._names:
            folder, _, file = name.rpartition("/")
            stem = file[:-len(".png")]
            base, state = _split_state(stem)
            if folder:
                colour = base.partition("_")[2] or "Default"
                colour = _SPELLING.get(colour, colour)
                files = shapes.setdefault(folder, {}).setdefault(colour, {})
                for key in ((state,) if state else ("off", "on")):
                    files[key] = name
            elif state:
                buttons.setdefault(base, {})[state] = name
        for colours in shapes.values():
            for files in colours.values():
                files.setdefault("off", files.get("on"))
                files.setdefault("on", files.get("off"))
        return {
            "shapes": {s: dict(sorted(c.items())) for s, c in sorted(shapes.items())},
            "buttons": {b: f for b, f in sorted(buttons.items()) if "off" in f and "on" in f},
        }

    def read(self, name: str) -> bytes:
        if name not in self._names:
            raise KeyError(name)
        with zipfile.ZipFile(self.path) as archive:
            return archive.read(_ROOT + name)


def _split_state(stem: str) -> tuple[str, str | None]:
    """Split "Squared_Aqua_OFF" into ("Squared_Aqua", "off")."""
    for suffix in ("_OFF", "_ON"):
        if stem.endswith(suffix):
            return stem[:-len(suffix)], suffix[1:].lower()
    return stem, None
