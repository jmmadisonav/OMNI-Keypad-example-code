"""Save button recipes so you can reopen and reuse them.

A recipe is the list of layers that make up a button. It's saved as
<name>.json, with the rendered OFF image as <name>.png for the thumbnail.
"""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path

from keypad_design import png_size

_NAME = re.compile(r"[A-Za-z0-9_-](?:[A-Za-z0-9 _-]{0,62}[A-Za-z0-9_-])?")
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{n}" for n in range(1, 10)),
             *(f"LPT{n}" for n in range(1, 10))}     # Reserved file names on Windows.


def validate_name(name: str) -> str:
    """Return name if it's safe to use as a file name, or raise ValueError."""
    if not isinstance(name, str) or not _NAME.fullmatch(name) or name.upper() in _RESERVED:
        raise ValueError(f"{name!r} isn't a valid name. Use 1 to 64 letters, digits, "
                         "spaces, dashes, or underscores, with no space at either end.")
    return name


class Library:
    def __init__(self, folder: str | Path):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)

    def list(self) -> list[dict]:
        items = []
        for path in sorted(self.folder.glob("*.json"), key=lambda p: p.stem.lower()):
            thumbnail = path.with_suffix(".png")
            items.append({"name": path.stem, "thumbnail": (
                "data:image/png;base64," + base64.b64encode(thumbnail.read_bytes()).decode("ascii")
                if thumbnail.exists() else "")})
        return items

    def get(self, name: str) -> dict:
        path = self._path(name, ".json")
        if not path.exists():
            raise FileNotFoundError(f"there's no recipe called {name!r}")
        return json.loads(path.read_text(encoding="utf-8"))

    def save(self, name: str, recipe: dict, thumbnail: bytes) -> dict:
        path = self._path(name, ".json")
        if not isinstance(recipe, dict) or recipe.get("version") != 1 \
                or not isinstance(recipe.get("layers"), list):
            raise ValueError("a recipe needs \"version\": 1 and a list of layers")
        png_size(thumbnail)                   # Raises ValueError if it isn't a PNG.
        recipe = {**recipe, "name": name}
        path.write_text(json.dumps(recipe, indent=2) + "\n", encoding="utf-8")
        path.with_suffix(".png").write_bytes(thumbnail)
        return recipe

    def delete(self, name: str) -> None:
        path = self._path(name, ".json")
        if not path.exists():
            raise FileNotFoundError(f"there's no recipe called {name!r}")
        path.unlink()
        path.with_suffix(".png").unlink(missing_ok=True)

    def _path(self, name: str, suffix: str) -> Path:
        return self.folder / (validate_name(name) + suffix)
