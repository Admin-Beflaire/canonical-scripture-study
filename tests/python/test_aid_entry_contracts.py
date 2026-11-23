"""Synthetic checks of the language-aid entry table: record schema, keys and output immutability."""

import json
from pathlib import Path
import sqlite3
import unittest

from css_preparation.prepare.records import RecordError, RecordSet

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / "schemas/evidence.v1.manifest.json").read_text())
TABLE = MANIFEST["aid_entries"]["record_tables"]["aid_entry"]
SHA = "a" * 64
ROW = {
    "output_id": "aid_entries:one",
    "entry": 0,
    "kind": "lexicon_entry",
    "entry_key": "tbesh:0",
    "lookup_key": "H0001",
    "byte_offset": 0,
    "byte_length": 10,
    "sha256": SHA,
}


class AidEntryContractsTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.execute("PRAGMA foreign_keys=ON")
        for path in sorted((ROOT / "schemas/migrations").glob("*.sql")):
            self.db.executescript(path.read_text())
        self.db.executemany(
            "INSERT INTO prepared_outputs VALUES (?, 'aid_entries', '[\"source\"]', 'fixture/1', '{}', '{}', '{}')",
            [("aid_entries:one",), ("aid_entries:two",)],
        )

    def insert(self, **change):
        row = {**ROW, **change}
        self.db.execute(
            f"INSERT INTO {TABLE} ({','.join(row)}) VALUES ({','.join('?' for _ in row)})",
            list(row.values()),
        )

    def select(self, output_id):
        self.db.execute(
            "INSERT INTO releases VALUES ('r1', 'm', 'r', '{\"evidence_records\":\"1\"}', 'c', 'q', 's')"
        )
        self.db.execute("INSERT INTO release_outputs VALUES ('r1', ?)", (output_id,))
        self.db.execute("UPDATE release_selection SET current_release_id = 'r1'")

    def test_the_json_expression_indexes_of_the_old_aid_rows_are_gone(self):
        names = {
            row[0]
            for row in self.db.execute(
                "SELECT name FROM sqlite_master WHERE type='index'"
            )
        }
        for gone in (
            "annotations_lexicon_entry_key",
            "annotations_lexicon_strong_base",
            "annotations_grammar_code",
            "annotations_proper_name_tag",
        ):
            self.assertNotIn(gone, names)
        for kept in ("annotations_span", "aid_entries_lookup", "aid_entries_entry_key"):
            self.assertIn(kept, names)

    def test_record_schema_accepts_a_row_and_refuses_bad_ones(self):
        records = RecordSet()
        records.add("aid_entry", ROW)
        self.assertEqual(records.rows("aid_entry"), [ROW])
        for change in (
            {"kind": "verse"},
            {"sha256": "xyz"},
            {"byte_length": 0},
            {"entry": -1},
            {"lookup_key": ""},
        ):
            with self.subTest(change=change), self.assertRaises(RecordError):
                RecordSet().add("aid_entry", {**ROW, **change})
        # An entry without a lookup key (such as a BDB article) is found by its entry key only.
        none = RecordSet()
        none.add("aid_entry", {**ROW, "lookup_key": None})
        self.assertEqual(len(none.statements()), 1)

    def test_table_refuses_bad_rows_and_duplicate_entries(self):
        self.insert()
        for change in ({"kind": "verse"}, {"sha256": "A" * 64}, {"byte_length": 0}):
            with self.subTest(change=change), self.assertRaises(sqlite3.IntegrityError):
                self.insert(entry=5, **change)
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert()
        with self.assertRaises(sqlite3.IntegrityError):
            self.insert(output_id="aid_entries:missing", entry=1)

    def test_rows_are_immutable_and_selected_outputs_cannot_change(self):
        self.insert()
        self.insert(output_id="aid_entries:two")
        with self.assertRaises(sqlite3.DatabaseError):
            self.db.execute(f"UPDATE {TABLE} SET byte_offset = 1")
        self.select("aid_entries:one")
        with self.assertRaises(sqlite3.DatabaseError):
            self.insert(entry=1)
        with self.assertRaises(sqlite3.DatabaseError):
            self.db.execute(f"DELETE FROM {TABLE} WHERE output_id = 'aid_entries:one'")
        # An output that is not selected can be removed whole, which is what cleanup does.
        self.db.execute(f"DELETE FROM {TABLE} WHERE output_id = 'aid_entries:two'")

    def test_lookups_use_their_indexes_and_come_back_in_a_fixed_order(self):
        self.insert()
        self.insert(output_id="aid_entries:two", entry=3, entry_key="tbesh:3")

        def lookup(index, field):
            return (
                f"SELECT k.output_id, e.entry FROM aid_output_keys k "
                f"CROSS JOIN aid_entry_rows e INDEXED BY {index} ON e.output_key = k.key "
                f"WHERE e.kind = 'lexicon_entry' AND e.{field} = ? ORDER BY k.output_id, e.entry"
            )

        by_key = lookup("aid_entries_lookup", "lookup_key")
        by_entry = lookup("aid_entries_entry_key", "entry_key")
        for sql, value in ((by_key, "H0001"), (by_entry, "tbesh:3")):
            plan = " ".join(
                row[3] for row in self.db.execute("EXPLAIN QUERY PLAN " + sql, (value,))
            )
            self.assertIn("USING COVERING INDEX aid_entries_", plan)
            self.assertNotIn("TEMP B-TREE", plan)
        self.assertEqual(
            self.db.execute(by_key, ("H0001",)).fetchall(),
            [("aid_entries:one", 0), ("aid_entries:two", 3)],
        )


class CompactEvidenceMigrationTests(unittest.TestCase):
    def test_existing_selected_evidence_round_trips_and_stays_immutable(self):
        fixture = json.loads(
            (ROOT / "tests/conformance/evidence-records.v1.json").read_text()
        )
        db = sqlite3.connect(":memory:")
        self.addCleanup(db.close)
        db.execute("PRAGMA foreign_keys=ON")
        migrations = sorted((ROOT / "schemas/migrations").glob("*.sql"))
        for path in migrations[:11]:
            db.executescript(path.read_text())
        records = RecordSet()
        for kind, rows in fixture["records"].items():
            if kind not in MANIFEST["record_tables"] or kind.startswith("release"):
                continue
            for row in rows:
                records.add(kind, row)
        for sql, params in records.statements():
            db.execute(sql, params)
        db.execute(
            """INSERT INTO annotations SELECT 'variant-a',output_id,source_revision_id,span_id,
            'textual_variants',provider,basis_json,details_json FROM annotations WHERE id='annotation-a'"""
        )
        db.execute(
            "INSERT INTO annotations SELECT 'variant-b',output_id,source_revision_id,span_id,kind,provider,basis_json,details_json FROM annotations WHERE id='variant-a'"
        )
        output = db.execute(
            "SELECT output_id FROM annotations WHERE id='variant-a'"
        ).fetchone()[0]
        db.execute(
            "INSERT INTO aid_entries VALUES (?, 0, 'lexicon_entry', 'key', 'H0001', 0, 10, ?)",
            (output, SHA),
        )
        db.execute(
            """INSERT INTO releases VALUES ('selected', 'm', 'r', '{"evidence_records":"1"}', 'c', 'q', 's')"""
        )
        db.execute("INSERT INTO release_outputs VALUES ('selected', ?)", (output,))
        db.execute("UPDATE release_selection SET current_release_id='selected'")
        before = {
            table: db.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall()
            for table in ("aid_entries", "annotations")
        }
        for path in migrations[11:13]:
            db.executescript("BEGIN;\n" + path.read_text() + "\nCOMMIT;")
        for table, rows in before.items():
            self.assertEqual(
                db.execute(f"SELECT * FROM {table} ORDER BY 1").fetchall(), rows
            )
        self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(
            db.execute("SELECT COUNT(*) FROM annotation_source_metadata").fetchone(),
            (1,),
        )
        self.assertEqual(
            db.execute(
                "SELECT COUNT(*) FROM annotation_rows WHERE provider IS NULL AND basis_json IS NULL"
            ).fetchone(),
            (2,),
        )
        for table in before:
            with self.assertRaisesRegex(
                sqlite3.IntegrityError, "Selected output rows are immutable"
            ):
                db.execute(f"DELETE FROM {table} WHERE output_id=?", (output,))


if __name__ == "__main__":
    unittest.main()
