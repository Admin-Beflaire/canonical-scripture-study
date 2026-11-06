import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("python_boundaries", ROOT / "tools/check_python_boundaries.py")
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class BoundaryTests(unittest.TestCase):
    def test_shared_cannot_import_preparation(self):
        self.assertTrue(CHECKER.check_source(ROOT, "packages/shared-python/src/css_shared/check.py", "import css_preparation"))

    def test_preparation_cannot_import_study_or_typescript(self):
        for source in ("import services.study", "import packages.shared", "from services.maintenance.control import tasks"):
            with self.subTest(source=source):
                self.assertTrue(CHECKER.check_source(ROOT, "services/maintenance/data-preparation/src/css_preparation/check.py", source))

    def test_unknown_paths_are_rejected(self):
        for file in ("services/other/file.py", "packages/other/file.py", "schemas/code.py"):
            with self.subTest(file=file):
                self.assertTrue(CHECKER.check_source(ROOT, file, ""))

    def test_valid_shared_and_relative_imports(self):
        self.assertEqual(CHECKER.check_source(ROOT, "services/maintenance/data-preparation/src/css_preparation/check.py", "from css_shared import parse_reference"), [])
        self.assertEqual(CHECKER.check_source(ROOT, "packages/shared-python/src/css_shared/check.py", "from .references import parse_reference"), [])

    def test_runtime_bridges_are_rejected(self):
        for source in ("__import__('css_preparation')", "import subprocess", "import importlib", "import os; os.system('node app.js')", "exec(source)"):
            with self.subTest(source=source):
                self.assertTrue(CHECKER.check_source(ROOT, "packages/shared-python/src/css_shared/check.py", source))

    def test_relative_escape_is_rejected(self):
        self.assertTrue(CHECKER.check_source(ROOT, "packages/shared-python/src/css_shared/check.py", "from ...css_preparation import tasks"))

    def test_multiprocessing_and_fork_bridges_are_rejected(self):
        for source in (
            "import multiprocessing",
            "from multiprocessing import Process",
            "import multiprocessing.pool",
            "import os; os.fork()",
            "import os; os.forkpty()",
        ):
            with self.subTest(source=source):
                self.assertTrue(CHECKER.check_source(ROOT, "packages/shared-python/src/css_shared/check.py", source))
