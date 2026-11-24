"""Temporary CI receipt of exact Ruff formatting; removed before review."""
import base64
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]
TARGET = "tests/python/test_preparation_candidate.py"


class P45RuffReceipt(unittest.TestCase):
    def test_ruff_receipt(self):
        subprocess.run(
            ["ruff", "format", TARGET],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
        data = (ROOT / TARGET).read_bytes()
        print("P45_RUFF::" + TARGET + "::" + base64.b64encode(data).decode("ascii"), flush=True)
