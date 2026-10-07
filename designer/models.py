"""The keypad models the designer supports.

Each model is a file in designer/models/: its name, button grid, whether it
has a dial and LED ring, faceplate shape, whether it's been tested on real
hardware, the size of its button images, and a one-page keypad.json that new
projects start from.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parent / "models"
DEFAULT_MODEL = "OMNI-KP-8BV"            # Projects made before models existed.

_DIAL_KEYS = ("ledring", "dial", "dial_button")
_FACEPLATES = ("square", "portrait")


@dataclass(frozen=True)
class Model:
    id: str
    name: str
    columns: int
    rows: int
    dial: bool
    faceplate: str
    tested: bool
    image_size: int          # Button images are image_size x image_size pixels.
    template: dict

    @property
    def buttons(self) -> int:
        return self.columns * self.rows

    def summary(self) -> dict:
        return {k: v for k, v in asdict(self).items() if k != "template"}


def load_models(folder: str | Path = MODELS_DIR) -> dict[str, Model]:
    """Load and check every model file, ordered by button count, then dial."""
    models = [_load(path) for path in sorted(Path(folder).glob("*.json"))]
    return {m.id: m for m in sorted(models, key=lambda m: (m.buttons, m.dial))}


def _load(path: Path) -> Model:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        model = Model(**{field: data[field] for field in Model.__dataclass_fields__})
        _check(model, path)
        return model
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"the model file {path.name} isn't valid: {error}") from None


def _check(model: Model, path: Path) -> None:
    if model.id != path.stem:
        raise ValueError(f"its id is {model.id!r}, but the file is named {path.name}")
    if not (isinstance(model.columns, int) and isinstance(model.rows, int)
            and model.columns > 0 and model.rows > 0):
        raise ValueError("columns and rows must be whole numbers")
    if type(model.image_size) is not int or model.image_size <= 0:
        raise ValueError("image_size must be a whole number of pixels")
    if model.faceplate not in _FACEPLATES:
        raise ValueError(f"faceplate must be one of {', '.join(_FACEPLATES)}")
    pages = model.template.get("pages")
    if not isinstance(pages, list) or len(pages) != 1:
        raise ValueError("the template must have exactly one page")
    page = pages[0]
    if len(page.get("buttons", [])) != model.buttons:
        raise ValueError(f"the template has {len(page.get('buttons', []))} buttons, "
                         f"but {model.columns} x {model.rows} is {model.buttons}")
    present = [key in page for key in _DIAL_KEYS]
    if any(present) != model.dial or all(present) != model.dial:
        raise ValueError(f"dial is {str(model.dial).lower()}, but the template's page "
                         f"{'lacks' if model.dial else 'has'} dial settings")
