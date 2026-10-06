"""Load the keypad's design and deploy new button images to it.

Every deploy downloads the design again, checks that nobody changed it since
you loaded it, saves it as a backup, and then uploads the new design with
03_upload_design.deploy().
"""

from __future__ import annotations

import base64
import binascii
import datetime
import hashlib
import importlib
import re
import threading
from dataclasses import dataclass
from pathlib import Path

from hcontrol import DEFAULT_PORT, HControlClient
from keypad_design import DESIGN_PATH, IMAGE_SIZE, Design, png_size

designs = importlib.import_module("03_upload_design")

_BACKUP_NAME = re.compile(r"(backup|loaded)_\d{8}_\d{6}(_\d+)?\.cpio")


class ConflictError(Exception):
    """The design on the keypad changed since you loaded it."""


class BusyError(Exception):
    """Another deploy or restore is running."""


class DeployTimeout(TimeoutError):
    def __init__(self, message: str, backup: str):
        super().__init__(message)
        self.backup = backup


@dataclass
class ButtonImages:
    page: int
    button: int
    name: str
    off: bytes
    on: bytes

    @classmethod
    def from_json(cls, item: dict) -> ButtonImages:
        page, button = int(item["page"]), int(item["button"])
        images = {}
        for state in ("off", "on"):
            try:
                data = base64.b64decode(item[state], validate=True)
                size = png_size(data)
            except (binascii.Error, ValueError, TypeError):
                raise ValueError(f"page {page} button {button}: the {state.upper()} image "
                                 "isn't a PNG") from None
            if size != IMAGE_SIZE:
                raise ValueError(f"page {page} button {button}: the {state.upper()} image is "
                                 f"{size[0]}x{size[1]}; buttons need "
                                 f"{IMAGE_SIZE[0]}x{IMAGE_SIZE[1]}")
            images[state] = data
        return cls(page, button, str(item.get("name") or ""), images["off"], images["on"])


def file_base(name: str, page: int, button: int) -> str:
    """Return the image file name stem for a recipe name, or p<page>b<button>."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", name)[:64] if name else f"p{page}b{button}"


def apply_buttons(design: Design, buttons: list[ButtonImages]) -> None:
    """Point each button at its new images, and drop images nothing uses.

    The changed buttons' old images are released first, so a recipe you
    deploy again keeps its file name. A name already used by a different
    image gets a short hash suffix instead of replacing that image.
    """
    targets = [design.button(b.page, b.button) for b in buttons]     # IndexError if missing.
    for target in targets:
        target["offImage"], target["onImage"] = [], []
    design.prune_images()
    for item, target in zip(buttons, targets):
        base = file_base(item.name, item.page, item.button)
        for key, state, data in (("offImage", "OFF", item.off), ("onImage", "ON", item.on)):
            name = f"{base}_{state}.png"
            if design.images.get(name, data) != data:
                name = f"{base}_{state}_{hashlib.sha1(data).hexdigest()[:6]}.png"
            design.images[name] = data
            target[key] = [name]


class KeypadOps:
    def __init__(self, backup_dir: str | Path, port: int = DEFAULT_PORT, timeout: float = 15.0):
        self.backup_dir = Path(backup_dir)
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        self.port = port
        self.timeout = timeout
        self._busy = threading.Lock()

    def load(self, host: str) -> dict:
        data = self._download(host)
        self._save(data, "loaded")
        design = Design.from_cpio(data)
        used = design.referenced_images()
        return {
            "fingerprint": design.fingerprint,
            "config": design.config,
            "images": {name: base64.b64encode(body).decode("ascii")
                       for name, body in design.images.items() if name in used},
        }

    def deploy(self, host: str, fingerprint: str, buttons: list[ButtonImages],
               force: bool = False) -> dict:
        with self._exclusive():
            data = self._download(host)
            design = Design.from_cpio(data)
            if design.fingerprint != fingerprint and not force:
                raise ConflictError("the design on the keypad changed since you loaded it")
            apply_buttons(design, buttons)
            backup = self._save(data, "backup")
            try:
                designs.deploy(host, self.port, design=design, backup_first=False)
            except TimeoutError as error:
                raise DeployTimeout(f"the keypad didn't restart with the new design: {error}",
                                    backup.name) from error
            return {"backup": backup.name, "fingerprint": design.fingerprint}

    def restore(self, host: str, backup: str) -> dict:
        if not _BACKUP_NAME.fullmatch(backup):
            raise ValueError(f"{backup!r} isn't a backup file name")
        path = self.backup_dir / backup
        if not path.exists():
            raise FileNotFoundError(f"there's no backup called {backup}")
        with self._exclusive():
            data = path.read_bytes()
            designs.deploy(host, self.port, data=data, backup_first=False)
            return {"fingerprint": Design.from_cpio(data).fingerprint}

    def backups(self) -> list[str]:
        names = [p.name for p in self.backup_dir.glob("*.cpio") if _BACKUP_NAME.fullmatch(p.name)]
        return sorted(names, key=lambda n: n.split("_", 1)[1], reverse=True)

    # -- Helpers -----------------------------------------------------------------

    def _download(self, host: str) -> bytes:
        try:
            with HControlClient(host, self.port, timeout=self.timeout) as kp:
                return kp.get_file(DESIGN_PATH)
        except TimeoutError:
            raise TimeoutError(
                f"the keypad at {host} didn't send its design. It might have no design "
                "loaded, for example after a factory reset.") from None

    def _save(self, data: bytes, prefix: str) -> Path:
        stamp = f"{datetime.datetime.now():%Y%m%d_%H%M%S}"
        path = self.backup_dir / f"{prefix}_{stamp}.cpio"
        counter = 1
        while path.exists():
            path = self.backup_dir / f"{prefix}_{stamp}_{counter}.cpio"
            counter += 1
        path.write_bytes(data)
        return path

    def _exclusive(self):
        if not self._busy.acquire(blocking=False):
            raise BusyError("another deploy or restore is running. Wait for it to finish.")
        return _Release(self._busy)


class _Release:
    def __init__(self, lock: threading.Lock):
        self._lock = lock

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self._lock.release()
