"""Synthetic reader-reference schema and release-membership checks."""
import json
from pathlib import Path
import sqlite3
import unittest

from css_shared import extract_scalar_segments

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / "schemas/evidence.v1.manifest.json").read_text())
TABLES = MANIFEST["reader_references"]["record_tables"]
FIXTURE = json.loads((ROOT / "tests/conformance/reader-references.v1.json").read_text())
VERSION = FIXTURE["reader_scheme_version"]


class ReaderReferenceContractsTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript((ROOT / "schemas" / MANIFEST["migration"]).read_text())
        self.add_release("legacy")
        self.db.execute("UPDATE release_selection SET current_release_id='legacy'")
        for path in sorted((ROOT / "schemas/migrations").glob("*.sql"))[1:]:
            self.db.executescript(path.read_text())
        self.db.executemany(
            """INSERT INTO source_nodes VALUES (?, ?, ?, ?, 'synthetic', 'fixture', '{}')""",
            [(id_, kind, parent, id_) for id_, kind, parent in [
                ("work", "work", None), ("edition", "edition", "work"),
                ("representation", "representation", "edition"), ("source", "source_revision", "representation"),
                ("other", "source_revision", "representation"),
            ]],
        )
        self.db.executemany(
            """INSERT INTO prepared_outputs VALUES (?, ?, '["source"]', 'fixture/1', '{}', '{}', '{}')""",
            [("text", "native_text"), ("mapping", "reader_reference")],
        )
        payload = "a" * 64
        self.db.execute("INSERT INTO text_payloads VALUES (?, 'Title😀Body')", (payload,))
        self.db.executemany(
            """INSERT INTO native_spans VALUES
            (?, 'text', 'source', NULL, ?, ?, ?, 'native/1', ?, '{}', ?, '[]', 'preserved')""",
            [
                ("title", "superscription", "native-title", 0,
                 '[{"unit_id":"Psa.3.1","start":0,"end":6}]', payload),
                ("numbered", "verse", "native-verse-1", 1,
                 '[{"unit_id":"Psa.3.1","start":6,"end":10}]', payload),
            ],
        )

    def add_release(self, release_id, version=None):
        formats = {"evidence_records": "1"}
        if version is not None:
            formats["reader_scheme_version"] = version
        self.db.execute("INSERT INTO releases VALUES (?, 'm', 'r', ?, 'c', 'q', 's')",
                        (release_id, json.dumps(formats)))

    def insert(self, kind, row):
        values = [json.dumps(value) if key.endswith("_json") else value for key, value in row.items()]
        self.db.execute(
            f"INSERT INTO {TABLES[kind]} ({','.join(row)}) VALUES ({','.join('?' for _ in row)})",
            values,
        )

    def insert_mappings(self):
        for kind, rows in FIXTURE["records"].items():
            for row in rows:
                self.insert(kind, row)

    def attach(self, release_id):
        self.db.execute("INSERT INTO release_outputs VALUES (?, 'text')", (release_id,))
        self.db.execute("INSERT INTO release_outputs VALUES (?, 'mapping')", (release_id,))

    def test_migration_keeps_legacy_selection_and_rejects_mixed_catalogues(self):
        self.assertEqual(self.db.execute("SELECT current_release_id FROM release_selection").fetchone()[0], "legacy")
        self.insert_mappings()
        for release, version in [("missing-version", None), ("wrong-version", "nrsva/2"), ("right", VERSION)]:
            self.add_release(release, version)
        for release in ["missing-version", "wrong-version"]:
            with self.assertRaisesRegex(sqlite3.IntegrityError, "matching release catalogue"):
                self.db.execute("INSERT INTO release_outputs VALUES (?, 'mapping')", (release,))
        self.attach("right")
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_links_and_checked_ranges_are_selected_by_release(self):
        self.insert_mappings()
        self.add_release("right", VERSION)
        self.attach("right")
        sql = """
          SELECT l.role, l.status, l.gap_reason, ns.coordinate_version, ns.segments_json
          FROM release_outputs ro JOIN reader_reference_links l ON l.output_id=ro.output_id
          LEFT JOIN native_spans ns ON ns.id=l.span_id
          WHERE ro.release_id=? AND l.source_revision_id='source'
            AND l.reader_scheme_version=? AND l.reader_ref=?
          ORDER BY l.ordinal
        """
        self.assertEqual(self.db.execute(sql, ("legacy", VERSION, "Ps.3.1")).fetchall(), [])
        self.assertEqual(self.db.execute(sql, ("right", "nrsva/2", "Ps.3.1")).fetchall(), [])
        links = self.db.execute(sql, ("right", VERSION, "Ps.3.1")).fetchall()
        self.assertEqual([row["role"] for row in links], ["superscription", "numbered_text"])
        for row, expected in zip(links, ["Title😀", "Body"], strict=True):
            reference = {"schema_version": "native-reference/1", "source_revision_id": "source",
                         "coordinate_version": row["coordinate_version"], "segments": json.loads(row["segments_json"])}
            actual = extract_scalar_segments(reference, {
                "units": {"Psa.3.1": "Title😀Body"},
                "source_revision_id": "source",
                "coordinate_version": "native/1",
            })
            self.assertEqual(actual, [expected])
        ambiguous = self.db.execute(sql, ("right", VERSION, "Ps.3.4")).fetchone()
        self.assertEqual(ambiguous["status"], "ambiguous")
        self.assertTrue(ambiguous["gap_reason"])
        self.assertIsNone(ambiguous["segments_json"])
        base = self.db.execute("""
          SELECT b.checked_extent_json FROM release_outputs ro
          JOIN reader_reference_bases b ON b.output_id=ro.output_id
          WHERE ro.release_id='right' AND b.source_revision_id='source'
        """).fetchone()
        checked_range, = json.loads(base[0])["ranges"]
        self.assertEqual((checked_range["first_verse"], checked_range["last_verse"]), (2, 3))

    def test_rejects_cross_source_links_and_guards_selected_mappings(self):
        link = FIXTURE["records"]["reader_reference_link"][1]
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert("reader_reference_link", {**link, "source_revision_id": "other"})
        self.insert_mappings()
        self.add_release("right", VERSION)
        self.attach("right")
        self.db.execute("UPDATE release_selection SET current_release_id='right', previous_release_id='legacy'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert("reader_reference_link", {**link, "id": "late", "ordinal": 2})
        for table in TABLES.values():
            with self.subTest(table=table), self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
                self.db.execute(f"DELETE FROM {table}")
