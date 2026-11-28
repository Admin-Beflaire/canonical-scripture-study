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


if __name__ == "__main__":
    unittest.main()
