import copy
import datetime
import json
import struct
import tempfile
import unittest
import warnings
import zlib
from pathlib import Path

from keypad_design import MAX_PAGES, Design, pack_cpio, png_size, unpack_cpio
from tests.helpers import FIXTURES


def make_png(width: int, height: int) -> bytes:
    """Build a minimal valid PNG header (enough for png_size)."""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    chunk = struct.pack(">I", len(ihdr)) + b"IHDR" + ihdr
    return b"\x89PNG\r\n\x1a\n" + chunk + struct.pack(">I", zlib.crc32(b"IHDR" + ihdr))


def mtime_of(archive: bytes) -> int:
    return int(archive[48:59], 8)


class CpioTests(unittest.TestCase):
    def test_round_trip_is_byte_exact_for_architect_upload(self):
        data = (FIXTURES / "architect_upload.cpio").read_bytes()
        self.assertEqual(pack_cpio(unpack_cpio(data), mtime_of(data)), data)

    def test_round_trip_is_byte_exact_for_design_with_images(self):
        data = (FIXTURES / "original_design.cpio").read_bytes()
        self.assertEqual(pack_cpio(unpack_cpio(data), mtime_of(data)), data)

    def test_unpack_lists_files_in_order(self):
        files = unpack_cpio((FIXTURES / "original_design.cpio").read_bytes())
        names = list(files)
        self.assertEqual(names[0], "keypad.json")
        self.assertEqual(len(names), 13)
        self.assertTrue(all(n.startswith("images/") for n in names[1:]))

    def test_bad_magic_raises(self):
        with self.assertRaisesRegex(ValueError, "bad magic"):
            unpack_cpio(b"PK\x03\x04" + b"0" * 100)

    def test_truncated_archive_raises(self):
        data = (FIXTURES / "architect_upload.cpio").read_bytes()
        with self.assertRaisesRegex(ValueError, "truncated"):
            unpack_cpio(data[:200])

    def test_empty_archive_is_just_a_trailer(self):
        self.assertEqual(unpack_cpio(pack_cpio({})), {})


class PngTests(unittest.TestCase):
    def test_png_size_reads_header(self):
        self.assertEqual(png_size(make_png(188, 188)), (188, 188))

    def test_png_size_rejects_other_files(self):
        with self.assertRaisesRegex(ValueError, "not a PNG"):
            png_size(b"GIF89a" + b"\0" * 30)


class DesignTests(unittest.TestCase):
    def setUp(self):
        self.design = Design.from_cpio((FIXTURES / "original_design.cpio").read_bytes())
        self.tmp = Path(tempfile.mkdtemp())

    def test_from_cpio_reads_pages_and_images(self):
        self.assertEqual([p["name"] for p in self.design.pages], ["Page 1", "Page 2"])
        self.assertEqual(len(self.design.images), 12)
        self.assertIn("nav_next-page_arrow_blue3d_188x188.png", self.design.images)

    def test_from_cpio_without_keypad_json_raises(self):
        with self.assertRaisesRegex(ValueError, "no keypad.json"):
            Design.from_cpio(pack_cpio({"images/a.png": b"x"}))

    def test_unbind_all_clears_every_binding(self):
        self.design.unbind_all()
        for page in self.design.pages:
            for control in [page["ledring"], page["dial"], page["dial_button"], *page["buttons"]]:
                self.assertEqual(control["remote"], "")
                self.assertEqual(control["path"], "")
                self.assertEqual(control.get("destination", ""), "")

    def test_set_dial_range_sets_dial_and_ledring(self):
        self.design.set_dial_range(2, 0, 100)
        page = self.design.page(2)
        self.assertEqual((page["dial"]["min"], page["dial"]["max"]), (0.0, 100.0))
        self.assertEqual((page["ledring"]["min"], page["ledring"]["max"]), (0.0, 100.0))

    def test_set_button_images_copies_files_and_references_them(self):
        (self.tmp / "Mute_OFF.png").write_bytes(make_png(188, 188))
        (self.tmp / "Mute_ON.png").write_bytes(make_png(188, 188))
        self.design.set_button_images(1, 3, off=self.tmp / "Mute_OFF.png", on=self.tmp / "Mute_ON.png")
        button = self.design.button(1, 3)
        self.assertEqual(button["offImage"], ["Mute_OFF.png"])
        self.assertEqual(button["onImage"], ["Mute_ON.png"])
        self.assertIn("Mute_ON.png", self.design.images)

    def test_set_button_images_warns_on_wrong_size(self):
        (self.tmp / "big.png").write_bytes(make_png(256, 256))
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            self.design.set_button_images(1, 1, on=self.tmp / "big.png")
        self.assertIn("256x256", str(caught[0].message))

    def test_set_button_images_rejects_non_png(self):
        (self.tmp / "photo.jpg").write_bytes(b"\xff\xd8\xff" + b"\0" * 40)
        with self.assertRaisesRegex(ValueError, "not a PNG"):
            self.design.set_button_images(1, 1, on=self.tmp / "photo.jpg")

    def test_out_of_range_page_or_button_names_the_limit(self):
        with self.assertRaisesRegex(IndexError, "has 2 pages"):
            self.design.page(3)
        with self.assertRaisesRegex(IndexError, "has 8 buttons"):
            self.design.button(1, 9)
        with self.assertRaises(IndexError):
            self.design.page(0)

    def test_prune_images_drops_unreferenced(self):
        for page in self.design.pages:
            for button in page["buttons"]:
                button["offImage"] = button["onImage"] = []
        self.design.prune_images()
        self.assertEqual(self.design.images, {})

    def test_to_cpio_sets_new_fingerprint_and_timestamp(self):
        old = self.design.fingerprint
        data = self.design.to_cpio(now=datetime.datetime(2026, 10, 1, 21, 5, 9))
        config = json.loads(unpack_cpio(data)["keypad.json"])
        self.assertNotEqual(config["fingerprint"], old)
        self.assertRegex(config["fingerprint"], r"^[0-9a-f]{32}$")
        self.assertEqual(config["lastdeployedtimestamp"], "1/10/2026 9:05:09 PM")
        self.assertEqual(self.design.fingerprint, config["fingerprint"])

    def test_to_cpio_refuses_missing_images(self):
        del self.design.images["AWC62_with-label-bar_188x188.png"]
        self.assertEqual(self.design.missing_images(), ["AWC62_with-label-bar_188x188.png"])
        with self.assertRaisesRegex(ValueError, "AWC62_with-label-bar_188x188.png"):
            self.design.to_cpio()

    def test_to_cpio_refuses_more_than_max_pages(self):
        page = self.design.pages[0]
        self.design.config["pages"] = [copy.deepcopy(page) for _ in range(MAX_PAGES + 1)]
        with self.assertRaisesRegex(ValueError, "10 pages.*at most 9"):
            self.design.to_cpio()

    def test_to_cpio_accepts_max_pages(self):
        page = self.design.pages[0]
        self.design.config["pages"] = [copy.deepcopy(page) for _ in range(MAX_PAGES)]
        self.assertEqual(len(Design.from_cpio(self.design.to_cpio()).pages), MAX_PAGES)

    def test_to_cpio_then_from_cpio_keeps_images(self):
        again = Design.from_cpio(self.design.to_cpio())
        self.assertEqual(again.images, self.design.images)
        self.assertEqual(again.pages, self.design.pages)

    def test_save_then_load_round_trips(self):
        self.design.save(self.tmp / "d")
        loaded = Design.load(self.tmp / "d")
        self.assertEqual(loaded.config, self.design.config)
        self.assertEqual(loaded.images, self.design.images)


if __name__ == "__main__":
    unittest.main()
