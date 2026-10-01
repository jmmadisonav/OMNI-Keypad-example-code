"""Shared helpers for tests that talk to the fake keypad."""

import contextlib
import io
import time
import unittest
from pathlib import Path

from hcontrol import HControlClient
from tests.fake_keypad import FakeKeypad

FIXTURES = Path(__file__).parent / "fixtures"


def wait_until(predicate, timeout: float = 2.0) -> bool:
    """Poll predicate() until it's true or the timeout passes."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


class KeypadTestCase(unittest.TestCase):
    """Starts a FakeKeypad and connects self.kp to it for each test.

    Set `params` on a subclass to change the fake keypad's parameters.
    Anything the code under test prints is captured in self.output.
    """

    params = None

    def setUp(self):
        self.keypad = FakeKeypad(self.params).__enter__()
        self.addCleanup(self.keypad.__exit__, None, None, None)
        self.kp = HControlClient("127.0.0.1", self.keypad.port, timeout=1.0)
        self.addCleanup(self.kp.close)
        self.output = io.StringIO()
        redirect = contextlib.redirect_stdout(self.output)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)
