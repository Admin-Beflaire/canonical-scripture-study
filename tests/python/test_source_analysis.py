from io import BytesIO
import json
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from css_preparation.runner.source_analysis import (
    AnalysisRefusedError,
    inspect_original,
)


def archive(path: str) -> bytes:
    stream = BytesIO()
    with ZipFile(stream, "w") as out:
        out.writestr(
            path,
            "\\id GEN\n\\c 1\n\\p\n\\v 1 A synthetic line.\n"
            "\\v 3-4 synthetic\n\\v 3-4 again\n\\wj text\\wj*.\n",
        )
        out.writestr("notice.txt", "Synthetic notice")
    return stream.getvalue()


class OriginalAnalysisTest(unittest.TestCase):
    def test_usfm_facts_without_wording(self):
        report = inspect_original(archive("01-GEN.usfm"), "original.zip")
        self.assertEqual(report["format"], "zip")
        source, chapter, notice = report["facts"]
        self.assertEqual(source["books"]["GEN"]["chapters"], [[1]])
        self.assertEqual(source["markup"]["wj*"], 1)
        self.assertEqual(chapter["verses"], [[1], [3, 4]])
        self.assertEqual(chapter["gaps"], [[2]])
        self.assertEqual(chapter["repeats"], {"3-4": 2})
        self.assertEqual(notice["inspection"], "unsupported_format")
        self.assertNotIn("synthetic", json.dumps(report).lower())

    def test_archive_bounds_and_paths(self):
        data = archive("safe.usfm")
        with (
            patch("css_preparation.runner.source_analysis.MAX_FILES", 1),
            self.assertRaises(AnalysisRefusedError),
        ):
            inspect_original(data, "original.zip")
        with self.assertRaises(AnalysisRefusedError):
            inspect_original(archive("../outside.usfm"), "original.zip")
