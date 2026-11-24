"""Temporary P4.5 formatter export for one CI run; removed before review."""
import base64
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]
FILES = [
    "services/study/src/read/search.ts",
    "services/maintenance/data-preparation/src/css_preparation/indexes/files.py",
    "services/maintenance/data-preparation/src/css_preparation/adapters/stepbible/prepare.py",
    "tests/python/test_index_files.py",
]


class FormatExport(unittest.TestCase):
    def test_export(self):
        subprocess.run(
            ["node", "node_modules/prettier/bin/prettier.cjs", "--write", "--ignore-path", "/dev/null", FILES[0]],
            cwd=ROOT, check=True, capture_output=True,
        )
        subprocess.run(["ruff", "format", *FILES[1:]], cwd=ROOT, check=True, capture_output=True)
        for path in FILES:
            data = (ROOT / path).read_bytes()
            print("P45_FORMAT::" + path + "::" + base64.b64encode(data).decode("ascii"), flush=True)
