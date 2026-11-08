"""Generate and rehearse the fixed Study fit fixture using local SQLite and files."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys


ROOT = Path(__file__).resolve().parents[2]
CONFORMANCE = ROOT / "tests/conformance"
INDEXES = CONFORMANCE / "indexes"
RELEASE = "ix-release"


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def fixture_rows(fixture):
    manifest = load(ROOT / "schemas/evidence.v1.manifest.json")
    base = load(CONFORMANCE / "evidence-records.v1.json")["records"]
    source = "synthetic:a:source_revision"
    for row in base["source_node"]:
        if row["id"].startswith("synthetic:a:"):
            yield "source_nodes", row
    for row in base["admission"]:
        if row["source_revision_id"] == source and row["component"] == "text":
            yield "admissions", row
    for kind, records in fixture["evidence_delta"].items():
        if kind == "release":
            for row in fixture["span_segments"]:
                yield "span_segments", row
        for row in records:
            yield manifest["record_tables"][kind], row


def sql_value(db, key, value):
    if key.endswith("_json"):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return db.execute("SELECT quote(?)", (value,)).fetchone()[0]


def prepare(output):
    fixture = load(INDEXES / "fixture.json")
    objects = []
    for row in fixture["evidence_delta"]["artifact"]:
        filename = fixture["artifact_files"][row["id"]]
        data = (INDEXES / filename).read_bytes()
        if len(data) != row["byte_count"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise ValueError(f"Fixture digest or size mismatch for {filename}")
        objects.append({"file": filename, "key": row["registered_locator"],
                        "bytes": len(data), "sha256": row["sha256"]})

    with sqlite3.connect(":memory:") as db:
        db.execute("PRAGMA foreign_keys = ON")
        for migration in sorted((ROOT / "schemas/migrations").glob("*.sql")):
            db.executescript(migration.read_text(encoding="utf-8"))

        insert = []
        delete = []
        for table, row in fixture_rows(fixture):
            columns = list(row)
            values = [sql_value(db, key, row[key]) for key in columns]
            insert.append(f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join(values)});")
            terms = [f"{key} IS {value}" for key, value in zip(columns, values)]
            delete.append(f"DELETE FROM {table} WHERE {' AND '.join(terms)};")

        select = (
            "UPDATE release_selection SET current_release_id = 'ix-release' "
            "WHERE singleton_id = 1 AND current_release_id IS NULL AND previous_release_id IS NULL;"
        )
        clear = (
            "UPDATE release_selection SET current_release_id = NULL "
            "WHERE singleton_id = 1 AND current_release_id = 'ix-release' AND previous_release_id IS NULL;"
        )
        tables = sorted({table for table, _ in fixture_rows(fixture)})
        counts = {table: db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in tables}
        db.executescript("\n".join(insert + [select]))
        assert db.execute("SELECT current_release_id, previous_release_id FROM release_selection").fetchone() == (RELEASE, None)
        assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        db.executescript("\n".join([clear] + delete[::-1]))
        assert db.execute("SELECT current_release_id, previous_release_id FROM release_selection").fetchone() == (None, None)
        assert all(db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == count
                   for table, count in counts.items())

    output.mkdir()
    (output / "insert.sql").write_text("\n".join(insert) + "\n", encoding="utf-8")
    (output / "select.sql").write_text(select + "\n", encoding="utf-8")
    (output / "clear.sql").write_text(clear + "\n", encoding="utf-8")
    (output / "delete.sql").write_text("\n".join(delete[::-1]) + "\n", encoding="utf-8")
    (output / "objects.json").write_text(json.dumps(objects, indent=2) + "\n", encoding="utf-8")
    print(f"Rehearsed {len(insert)} fixture rows and verified {len(objects)} objects")


if __name__ == "__main__":
    prepare(Path(sys.argv[1]))
