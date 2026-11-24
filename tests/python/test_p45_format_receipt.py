"""Temporary CI formatter receipt; deleted in the next commit."""
import base64
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]
FILES = [
    "services/study/src/read/search.ts",
    "tests/study/search.test.ts",
]


class P45FormatReceipt(unittest.TestCase):
    def test_format_receipt(self):
        subprocess.run(
            ["node", "node_modules/prettier/bin/prettier.cjs", "--write", *FILES],
            cwd=ROOT, capture_output=True, text=True, check=True,
        )
        for path in FILES:
            data = (ROOT / path).read_bytes()
            print("P45_FORMAT::" + path + "::" + base64.b64encode(data).decode("ascii"), flush=True)
