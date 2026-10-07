"""Load designs from the keypad and deploy designs to it.

Every deploy downloads the keypad's design first and saves it as a backup.
A keypad with no design doesn't answer that download, so the deploy goes
ahead without a backup. Uploads use 03_upload_design.upload() and
wait_for_design().
"""

from __future__ import annotations

import base64
import binascii
import copy
import datetime
import hashlib
import importlib
import re
import threading
from dataclasses import dataclass
from pathlib import Path

from hcontrol import DEFAULT_PORT, HControlClient, HControlError
from keypad_design import DESIGN_PATH, IMAGE_SIZE, MAX_PAGES, Design, png_size

from designer.models import DEFAULT_MODEL

designs = importlib.import_module("03_upload_design")

_BACKUP_NAME = re.compile(r"(backup|loaded)_\d{8}_\d{6}(_\d+)?\.cpio")


class ConflictError(Exception):
    """The design on the keypad changed since you loaded it."""


class BusyError(Exception):
    """Another deploy or restore is running."""


class ModelMismatch(Exception):
    """The keypad is a different model from the one the project is for."""

    def __init__(self, expected: str, actual: str):
        super().__init__(f"the project is for an {expected}, but the keypad is an {actual}")
        self.expected = expected
        self.actual = actual


class DeployTimeout(TimeoutError):
    def __init__(self, message: str, backup: str):
        super().__init__(message)
        self.backup = backup


class DeployFailed(ConnectionError):
    """The upload failed partway, so the keypad might have no design."""

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
        try:
            page, button = int(item["page"]), int(item["button"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("each button needs whole-number \"page\" and \"button\" "
                             "fields") from None
        images = {}
        for state in ("off", "on"):
            try:
                data = base64.b64decode(item.get(state) or "", validate=True)
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


@dataclass
class Layout:
    """The pages you want, in order, and where each button switches to.

    Each page is (name, source): source is the number of the loaded page it
    comes from, or None for a new, empty page. Destinations map
    (page, button) in the new numbering to the name of a page.
    """

    pages: list[tuple[str, int | None]]
    destinations: dict[tuple[int, int], str]

    @classmethod
    def from_json(cls, item: dict) -> Layout:
        pages, destinations = item.get("pages"), item.get("destinations", [])
        if not isinstance(pages, list) or not isinstance(destinations, list):
            raise ValueError("the layout needs a list of pages and a list of destinations")
        result = cls([], {})
        for page in pages:
            name, source = (page.get("name"), page.get("source")) if isinstance(page, dict) else (None, None)
            if not isinstance(name, str) or not (source is None or type(source) is int):
                raise ValueError("each page needs a \"name\" and a page number or null as \"source\"")
            result.pages.append((name.strip(), source))
        for entry in destinations:
            try:
                key = (int(entry["page"]), int(entry["button"]))
                target = entry["destination"]
            except (KeyError, TypeError, ValueError):
                raise ValueError("each destination needs \"page\", \"button\", and "
                                 "\"destination\"") from None
            if not isinstance(target, str):
                raise ValueError("a destination must be a page name")
            result.destinations[key] = target
        return result


def apply_layout(design: Design, layout: Layout) -> None:
    """Rebuild the design's pages and set every button's destination.

    A new page copies page 1's structure (buttons, dial, and LED ring) with no
    images and no destinations. Images that no page uses any more are dropped.
    """
    if not 1 <= len(layout.pages) <= MAX_PAGES:
        raise ValueError(f"a design needs 1 to {MAX_PAGES} pages; this one has {len(layout.pages)}")
    names = [name for name, _ in layout.pages]
    if any(not name for name in names):
        raise ValueError("every page needs a name")
    if len(set(names)) != len(names):
        raise ValueError("page names must be different from each other")
    old = design.pages
    pages = []
    for name, source in layout.pages:
        if source is None:
            page = blank_page(old[0])
        elif 1 <= source <= len(old):
            page = copy.deepcopy(old[source - 1])
        else:
            raise ValueError(f"there's no loaded page {source} to copy")
        page["name"] = name
        pages.append(page)
    for (page, button), target in layout.destinations.items():
        if not 1 <= page <= len(pages) or not 1 <= button <= len(pages[page - 1]["buttons"]):
            raise ValueError(f"page {page} button {button} doesn't exist")
        if target not in names:
            raise ValueError(f"page {page} button {button} goes to {target!r}, "
                             "which isn't a page")
    design.config["pages"] = pages
    for page_number, page in enumerate(pages, 1):
        for button_number, button in enumerate(page["buttons"], 1):
            button["destination"] = layout.destinations.get((page_number, button_number), "")
    design.prune_images()


def blank_page(template: dict) -> dict:
    page = copy.deepcopy(template)
    for button in page.get("buttons", []):
        button["offImage"], button["onImage"], button["altImage"] = [], [], []
        button["destination"] = ""
    return page


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

    def download(self, host: str) -> bytes:
        """Download the keypad's design, and save a copy as loaded_<time>.cpio."""
        data = self._download(host)
        self._save(data, "loaded")
        return data

    def keypad_model(self, host: str) -> str:
        """Return the model the keypad reports, such as OMNI-KP-8BV."""
        try:
            client = HControlClient(host, self.port, timeout=min(self.timeout, 5))
        except OSError as error:
            raise ConnectionError(f"couldn't connect to the keypad at {host}: {error}") from None
        try:
            with client as kp:
                return str(kp.get("/configuration/device/model", fmt="string"))
        except TimeoutError:
            raise TimeoutError(f"the keypad at {host} stopped responding") from None

    def deploy_project(self, host: str, design: Design, base_fingerprint: str,
                       force: bool = False, model: str = DEFAULT_MODEL) -> dict:
        """Upload a whole project design to the keypad.

        Backs up the keypad's design first if it has one. A keypad with no
        design, for example after a factory reset, doesn't answer the
        download, so the upload goes ahead without a backup. If the keypad's
        design isn't the one the project last matched, refuse unless force.
        Refuse a keypad of another model, even with force.
        """
        with self._exclusive():
            actual = self.keypad_model(host)      # Before anything slow or risky.
            if actual != model:
                raise ModelMismatch(model, actual)
            try:
                current = self._download(host)    # ConnectionError if unreachable.
            except TimeoutError:
                # A keypad with no design never answers the download. A slow or
                # stalled keypad doesn't either, so check that it still answers
                # before uploading without a backup.
                if not self._answers(host):
                    raise TimeoutError(f"the keypad at {host} stopped responding while it "
                                       "sent its design. Nothing was uploaded.") from None
                current = None                    # No design to back up.
            backup = ""
            if current is not None:
                if Design.from_cpio(current).fingerprint != base_fingerprint and not force:
                    raise ConflictError(f"the keypad at {host} has a different design")
                backup = self._save(current, "backup").name
            data = design.to_cpio()               # New fingerprint.
            try:
                self._upload(host, data, design.fingerprint)
            except TimeoutError as error:
                raise DeployTimeout(f"the keypad didn't restart with the new design: {error}",
                                    backup) from error
            except (OSError, HControlError) as error:
                raise DeployFailed(f"the upload to the keypad at {host} failed: {error}",
                                   backup) from error
            return {"fingerprint": design.fingerprint, "backup": backup}

    def backup_data(self, backup: str) -> bytes:
        """Return the bytes of the named backup.

        Raises ValueError if the name isn't a backup file name, and
        FileNotFoundError if there's no such backup.
        """
        if not _BACKUP_NAME.fullmatch(backup):
            raise ValueError(f"{backup!r} isn't a backup file name")
        path = self.backup_dir / backup
        if not path.exists():
            raise FileNotFoundError(f"there's no backup called {backup}")
        return path.read_bytes()

    def restore(self, host: str, backup: str, model: str | None = None) -> dict:
        """Upload a backup to the keypad.

        If you pass model, refuse a keypad of another model.
        """
        data = self.backup_data(backup)
        with self._exclusive():
            if model is not None:
                actual = self.keypad_model(host)
                if actual != model:
                    raise ModelMismatch(model, actual)
            fingerprint = Design.from_cpio(data).fingerprint
            self._upload(host, data, fingerprint)
            return {"fingerprint": fingerprint}

    def backups(self) -> list[str]:
        names = [p.name for p in self.backup_dir.glob("*.cpio") if _BACKUP_NAME.fullmatch(p.name)]
        return sorted(names, key=lambda n: n.split("_", 1)[1], reverse=True)

    # -- Helpers -----------------------------------------------------------------

    def _download(self, host: str) -> bytes:
        try:
            client = HControlClient(host, self.port, timeout=self.timeout)
        except OSError as error:
            raise ConnectionError(f"couldn't connect to the keypad at {host}: {error}") from None
        try:
            with client as kp:
                return kp.get_file(DESIGN_PATH)
        except TimeoutError:
            raise TimeoutError(
                f"the keypad at {host} didn't send its design. It might have no design "
                "loaded, for example after a factory reset.") from None

    def _answers(self, host: str) -> bool:
        """Return True if the keypad answers a quick request on a new connection."""
        try:
            with HControlClient(host, self.port, timeout=min(self.timeout, 5)) as kp:
                kp.get("/configuration/device/model", fmt="string")
            return True
        except (OSError, HControlError):
            return False

    def _upload(self, host: str, data: bytes, fingerprint: str) -> None:
        """Upload a packed design and wait until the keypad runs it.

        This skips 03_upload_design.deploy() because that always downloads a
        backup first, which fails on a keypad with no design. The callers
        keep their own backups.
        """
        with HControlClient(host, self.port, timeout=self.timeout) as kp:
            designs.upload(kp, data)
        designs.wait_for_design(host, self.port, fingerprint)

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
