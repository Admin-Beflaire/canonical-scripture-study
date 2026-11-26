import hashlib
import json
import unittest

from css_preparation.adapters.step_aids import AidRecipe
from css_preparation.prepare.evidence import SourceIdentity, SourceLevel
from css_preparation.prepare.records import RecordError
from test_stepbible_lexicon import HEBREW
from test_oshb_bdb import BDB, INDEX
from test_stepbible_lsj import EXTRA

STEP = "5de0a47f35f0fc13dfe1430d104e5db8a4285f9c"
BDB_COMMIT = "21c9add13bc727d3a951361778e97e3ff7afd1ce"


class Store:
    def __init__(self, inputs):
        self.nodes, self.blobs = {}, {}
        for rev, data in inputs.items():
            key = "synthetic/" + rev
            identity = SourceIdentity(
                SourceLevel(rev + ":work", "work"),
                SourceLevel(rev + ":edition", "edition"),
                SourceLevel(rev + ":representation", "representation"),
                SourceLevel(
                    rev,
                    "revision",
                    {
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "byte_count": len(data),
                        "locator": key,
                    },
                ),
                "synthetic attribution",
                "https://example.test",
            )
            self.nodes.update({row["id"]: row for row in identity.rows()})
            self.blobs[key] = data

    def read_row(self, kind, key):
        return self.nodes.get(key) if kind == "source_node" else None

    def read_blob(self, key):
        return self.blobs[key]


def lines(records):
    """The entries file of a prepared output, one decoded line per entry."""
    (data,) = records.blobs.values()
    return [json.loads(line) for line in data.splitlines()]


def recipe(component, commit, revision):
    coord = "language-aids/" + component + "/1"
    unit = {
        "unit_id": "prepare-000",
        "kind": "prepare",
        "native_extent": {"unit_ids": ["p000"], "coordinate_version": coord},
        "depends_on": [],
    }
    cap = "grammar_expansion" if component in ("tehmc", "tegmc") else "lexicon_entry"
    raw = {"native_extent": {"coordinate_version": coord}, "units": [unit]}
    return AidRecipe(raw, component, commit, revision, cap, 1), unit


class PreparationTest(unittest.TestCase):
    def test_hebrew_preserves_restriction_and_private_body(self):
        rev = "fixture-tbesh/1"
        store = Store({rev: HEBREW.encode()})
        recipe_, unit = recipe("tbesh", STEP, rev)
        records = recipe_.prepare(
            {
                "kind": "prepare",
                "unit_id": unit["unit_id"],
                "native_extent": unit["native_extent"],
                "input_refs": [{"kind": "source_revision", "id": rev}],
            },
            store,
        )
        self.assertGreater(len(records.rows("aid_entry")), 1)
        self.assertEqual(records.rows("text_payload"), [])
        self.assertEqual(
            records.rows("native_span")
            + records.rows("annotation")
            + records.rows("span_segment"),
            [],
        )
        for line in lines(records):
            self.assertEqual(line["details"]["body_field"], "gloss")
            self.assertNotIn("definition", line["details"])
        self.assertEqual(records.rows("coverage")[0]["capability"], "lexicon_entry")
        # Every entry's wording is the native text it is read from, at the coordinates it states.
        native = recipe_.read_source(rev, store).unit("p000")
        for line in lines(records):
            segment = line["segments"][0]
            self.assertEqual(
                native[segment["start"] : segment["end"]], line["text"] or ""
            )

    def test_bdb_and_index_keep_separate_source_revisions(self):
        for component, data, rev, work in (
            ("bdb", BDB, "fixture-bdb/1", "oshb-bdb"),
            ("bdb-index", INDEX, "fixture-index/1", "oshb-lexical-index"),
        ):
            with self.subTest(component=component):
                store = Store({rev: data.encode()})
                reader, unit = recipe(component, BDB_COMMIT, rev)
                refs = [{"kind": "source_revision", "id": rev}]
                records = reader.prepare(
                    {
                        "kind": "prepare",
                        "unit_id": unit["unit_id"],
                        "native_extent": unit["native_extent"],
                        "input_refs": refs,
                    },
                    store,
                )
                self.assertEqual(
                    records.rows("prepared_output")[0]["input_revisions_json"], [rev]
                )
                self.assertTrue(
                    all(line["details"]["work_id"] == work for line in lines(records))
                )
                self.assertTrue(
                    all(
                        "work in progress" in line["details"]["source_limitation"]
                        for line in lines(records)
                    )
                )

    def test_saved_candidate_quality_checks_bdb_output(self):
        from css_preparation.prepare.evidence import OutputBasis
        from css_preparation.validate.saved import CandidateInventory
        from css_preparation.validate.semantic import check_saved_semantics

        rev = "fixture-bdb/1"
        store = Store({rev: BDB.encode()})
        reader, unit = recipe("bdb", BDB_COMMIT, rev)
        refs = [{"kind": "source_revision", "id": rev}]
        records = reader.prepare(
            {
                "kind": "prepare",
                "unit_id": unit["unit_id"],
                "native_extent": unit["native_extent"],
                "input_refs": refs,
            },
            store,
        )
        basis = OutputBasis(
            "aid_entries",
            (rev,),
            "language-aids/2",
            {"component": "bdb", "commit": BDB_COMMIT, "entries": "r2"},
            {"coordinate_version": "language-aids/bdb/1", "unit_ids": ["p000"]},
        )
        blobs = {
            row["registered_locator"]: records.blobs[row["id"]]
            for row in records.rows("artifact")
        }
        result = check_saved_semantics(
            {
                "input_refs": refs,
                "native_extent": {"unit_ids": ["p000"]},
                "required_capabilities": ["lexicon_entry"],
            },
            CandidateInventory(added=(basis,)),
            read_rows=lambda kind, _: records.rows(kind),
            read_blob=blobs.__getitem__,
            read_source=lambda revision: reader.read_source(revision, store),
            read_aid_entries=lambda job: reader.read_aid_entries(job, store),
        )
        self.assertIn("lexicon_entry", result.capabilities)

    def saved(self):
        from css_preparation.prepare.evidence import OutputBasis
        from css_preparation.validate.saved import CandidateInventory

        rev = "fixture-bdb/1"
        store = Store({rev: BDB.encode()})
        reader, unit = recipe("bdb", BDB_COMMIT, rev)
        refs = [{"kind": "source_revision", "id": rev}]
        records = reader.prepare(
            {
                "kind": "prepare",
                "unit_id": unit["unit_id"],
                "native_extent": unit["native_extent"],
                "input_refs": refs,
            },
            store,
        )
        basis = OutputBasis(
            "aid_entries",
            (rev,),
            "language-aids/2",
            {"component": "bdb", "commit": BDB_COMMIT, "entries": "r2"},
            {"coordinate_version": "language-aids/bdb/1", "unit_ids": ["p000"]},
        )
        return reader, store, records, refs, CandidateInventory(added=(basis,))

    def check(self, reader, store, records, refs, inventory, blobs=None):
        from css_preparation.validate.semantic import check_saved_semantics

        blobs = blobs or {
            row["registered_locator"]: records.blobs[row["id"]]
            for row in records.rows("artifact")
        }
        return check_saved_semantics(
            {
                "input_refs": refs,
                "native_extent": {"unit_ids": ["p000"]},
                "required_capabilities": ["lexicon_entry"],
            },
            inventory,
            read_rows=lambda kind, _: records.rows(kind),
            read_blob=blobs.__getitem__,
            read_source=lambda revision: reader.read_source(revision, store),
            read_aid_entries=lambda job: reader.read_aid_entries(job, store),
        )

    def test_quality_refuses_aid_entries_that_differ_from_the_source_or_their_file(
        self,
    ):
        from css_preparation.prepare.records import RecordSet

        reader, store, records, refs, inventory = self.saved()
        self.check(reader, store, records, refs, inventory)
        row = records.rows("aid_entry")[0]
        locator = records.rows("artifact")[0]["registered_locator"]
        bytes_ = next(iter(records.blobs.values()))
        # A row that points elsewhere in the file, a changed key, and a changed file are each refused.
        for change in (
            {"byte_offset": row["byte_offset"] + 1},
            {"entry_key": "other"},
            {"lookup_key": "H9999"},
        ):
            with self.subTest(change=change):
                tampered = RecordSet().merge(records)
                tampered._rows["aid_entry"][("%s" % row["output_id"], 0)] = {
                    **row,
                    **change,
                }
                with self.assertRaises(RecordError):
                    self.check(reader, store, tampered, refs, inventory)
        flipped = bytes_.replace(b'"entry":0', b'"entry":7', 1)
        self.assertNotEqual(flipped, bytes_)
        with self.assertRaises(RecordError):
            self.check(reader, store, records, refs, inventory, {locator: flipped})

    def test_aid_output_saves_into_d1_twice_and_passes_the_saved_checks(self):
        from css_preparation.executor.candidate import CandidateStore, persist_candidate
        from css_preparation.prepare.records import decoded, scoped_query
        from css_preparation.validate.saved import verify_candidate_inventory
        from preparation_fixture import database

        reader, store, records, refs, inventory = self.saved()
        db = database()
        self.addCleanup(db.close)
        blobs = {}

        def scoped(kind, ids):
            sql, params = scoped_query(kind, ids)
            return decoded(db.execute(sql, params).fetchall())

        def find(kind, identity):
            table = {"prepared_output": "prepared_outputs", "artifact": "artifacts"}[
                kind
            ]
            rows = decoded(
                db.execute(
                    f"SELECT * FROM {table} WHERE id = ?", (identity,)
                ).fetchall()
            )
            return rows[0] if rows else None

        def write(statements):
            with db:
                for sql, params in statements:
                    db.execute(sql, params)

        target = CandidateStore(
            blobs.__setitem__, blobs.__getitem__, write, find, scoped
        )
        first = persist_candidate(records, target)
        self.assertEqual(
            persist_candidate(records, target), first
        )  # a retry finds identical rows and bytes
        output = records.output_ids()
        self.assertEqual(
            scoped("aid_entry", output),
            sorted(records.rows("aid_entry"), key=lambda r: r["entry"]),
        )
        verify_candidate_inventory(
            inventory, read_rows=scoped, read_blob=blobs.__getitem__
        )
        # Entries that differ from the saved ones are not reused.
        db.execute("DELETE FROM aid_entries WHERE entry = 0")
        with self.assertRaises(RecordError):
            persist_candidate(records, target)

    def test_quality_rebuilds_from_the_original_not_from_the_partition_cache(self):
        from css_preparation.prepare.evidence import OutputBasis
        from css_preparation.validate.saved import CandidateInventory

        rev = "fixture-bdb/1"
        store = Store({rev: BDB.encode()})
        store.partitions = {}
        store.read_partition_cache = lambda key: store.partitions.get(key)
        store.write_partition_cache = lambda key, data: store.partitions.setdefault(
            key, data
        )
        reader, unit = recipe("bdb", BDB_COMMIT, rev)
        refs = [{"kind": "source_revision", "id": rev}]
        job = {
            "kind": "prepare",
            "unit_id": unit["unit_id"],
            "native_extent": unit["native_extent"],
            "input_refs": refs,
        }
        reader.prepare(job, store)  # writes the cache from the original
        for key, data in list(store.partitions.items()):
            value = json.loads(data)
            value["entries"][0]["body"] += " changed"
            store.partitions[key] = json.dumps(value).encode()
        records = reader.prepare(job, store)  # saves the changed cached wording
        self.assertIn(b"changed", next(iter(records.blobs.values())))
        basis = OutputBasis(
            "aid_entries",
            (rev,),
            "language-aids/2",
            {"component": "bdb", "commit": BDB_COMMIT, "entries": "r2"},
            {"coordinate_version": "language-aids/bdb/1", "unit_ids": ["p000"]},
        )
        with self.assertRaises(RecordError):
            self.check(reader, store, records, refs, CandidateInventory(added=(basis,)))
        # The same output without the change passes against the original.
        clean = Store({rev: BDB.encode()})
        good = reader.prepare(job, clean)
        self.check(reader, clean, good, refs, CandidateInventory(added=(basis,)))

    def test_quality_refuses_aid_outputs_without_a_verification_source(self):
        from css_preparation.validate.semantic import check_saved_semantics

        reader, store, records, refs, inventory = self.saved()
        blobs = {
            row["registered_locator"]: records.blobs[row["id"]]
            for row in records.rows("artifact")
        }
        with self.assertRaises(RecordError):
            check_saved_semantics(
                {
                    "input_refs": refs,
                    "native_extent": {"unit_ids": ["p000"]},
                    "required_capabilities": ["lexicon_entry"],
                },
                inventory,
                read_rows=lambda kind, _: records.rows(kind),
                read_blob=blobs.__getitem__,
                read_source=lambda revision: reader.read_source(revision, store),
            )

    def test_empty_lsj_meaning_is_a_gap_without_substituting_gloss(self):
        rev = "fixture-lsj/1"
        store = Store({rev: EXTRA.encode()})
        reader, unit = recipe("tflsj-extra", STEP, rev)
        records = reader.prepare(
            {
                "kind": "prepare",
                "unit_id": unit["unit_id"],
                "native_extent": unit["native_extent"],
                "input_refs": [{"kind": "source_revision", "id": rev}],
            },
            store,
        )
        last = lines(records)[-1]
        self.assertEqual((last["reading_kind"], last["text"]), ("gap", None))
        self.assertEqual(last["details"]["gloss"], "Sin")

    def test_recipe_must_list_the_source_revision_a_task_names(self):
        from pathlib import Path

        raw = json.loads(
            (
                Path(__file__).resolve().parents[2]
                / "collection/recipes/language-aids-bdb.json"
            ).read_text()
        )
        self.assertEqual(
            raw["task_inputs"],
            [{"kind": "source_revision", "id": raw["parameters"]["source_revision"]}],
        )
        AidRecipe.from_recipe(raw)
        for change in (
            {"task_inputs": []},
            {"task_inputs": [{"kind": "acquisition", "id": raw["dependencies"][0]}]},
        ):
            with self.subTest(change=change), self.assertRaises(RecordError):
                AidRecipe.from_recipe({**raw, **change})

    def test_all_recipe_partitions_fit_the_runner_batch_at_observed_sizes(self):
        from pathlib import Path
        from unittest.mock import patch
        from css_preparation.adapters.language_aid_entries import AidEntry
        from css_preparation.runner.cloudflare import _BATCH_STATEMENTS

        root = Path(__file__).resolve().parents[2]
        counts = {
            "tbesh": 11682,
            "tbesg": 11035,
            "tflsj-0-5624": 5709,
            "tflsj-extra": 5325,
            "tehmc": 1013,
            "tegmc": 1732,
            "bdb": 11845,
            "bdb-index": 10221,
        }
        for name, count in counts.items():
            with self.subTest(component=name):
                raw = json.loads(
                    (
                        root / "collection/recipes" / f"language-aids-{name}.json"
                    ).read_text()
                )
                reader = AidRecipe.from_recipe(raw)
                # Non-empty bodies give the maximum row count; actual gaps can only reduce it.
                entries = [
                    AidEntry(f"e{i}", "synthetic-work", "synthetic-edition", "text", {})
                    for i in range(count)
                ]
                store = Store({reader.revision: b"synthetic original"})
                method = (
                    "bdb_entries"
                    if name == "bdb"
                    else "bdb_index_entries"
                    if name == "bdb-index"
                    else "step_entries"
                )
                with patch(
                    "css_preparation.adapters.step_aids." + method, return_value=entries
                ):
                    units = [unit for unit in raw["units"] if unit["kind"] == "prepare"]
                    self.assertEqual(len(units), reader.partitions)
                    for unit in units:
                        records = reader.prepare(
                            {
                                "kind": "prepare",
                                "unit_id": unit["unit_id"],
                                "native_extent": unit["native_extent"],
                                "input_refs": [
                                    {"kind": "source_revision", "id": reader.revision}
                                ],
                            },
                            store,
                        )
                        self.assertLess(
                            len(records.statements()),
                            _BATCH_STATEMENTS,
                            f"{name} {unit['unit_id']}",
                        )

    def test_independent_partition_jobs_reuse_verified_r2_cache(self):
        from unittest.mock import patch
        from css_preparation.adapters.language_aid_entries import step_entries

        rev = "fixture-tbesh/1"
        store = Store({rev: HEBREW.encode()})
        store.partitions = {}
        store.read_partition_cache = lambda key: store.partitions.get(key)
        store.write_partition_cache = lambda key, data: store.partitions.setdefault(
            key, data
        )
        coord = "language-aids/tbesh/1"
        units = [
            {
                "unit_id": f"prepare-{i:03d}",
                "kind": "prepare",
                "native_extent": {
                    "unit_ids": [f"p{i:03d}"],
                    "coordinate_version": coord,
                },
                "depends_on": [],
            }
            for i in range(2)
        ]
        reader = AidRecipe(
            {"native_extent": {"coordinate_version": coord}, "units": units},
            "tbesh",
            STEP,
            rev,
            "lexicon_entry",
            2,
        )

        def run(unit):
            return reader.prepare(
                {
                    "kind": "prepare",
                    "unit_id": unit["unit_id"],
                    "native_extent": unit["native_extent"],
                    "input_refs": [{"kind": "source_revision", "id": rev}],
                },
                store,
            )

        with patch(
            "css_preparation.adapters.step_aids.step_entries", wraps=step_entries
        ) as parsed:
            first = run(units[0])
            assert parsed.call_count == 1  # One original read/parse for all partitions.
            second = run(units[1])
            self.assertEqual(
                parsed.call_count, 1, "later job must not reparse the full source"
            )
            self.assertEqual(len(store.partitions), 2)
            self.assertNotEqual(
                first.rows("prepared_output")[0]["id"],
                second.rows("prepared_output")[0]["id"],
            )
            # Cache hits must reconstruct *identical* evidence, including exact
            # body bytes, coordinate offsets, output statements and digests.
            direct = Store({rev: HEBREW.encode()})
            uncached = reader.prepare(
                {
                    "kind": "prepare",
                    "unit_id": units[1]["unit_id"],
                    "native_extent": units[1]["native_extent"],
                    "input_refs": [{"kind": "source_revision", "id": rev}],
                },
                direct,
            )
            self.assertEqual(second.statements(), uncached.statements())
            self.assertEqual(second.blobs, uncached.blobs)
            self.assertEqual(
                parsed.call_count,
                2,
                "uncached comparison intentionally parses once more",
            )
            # Quality reads the pinned original directly, independent of cached partitions.
            self.assertEqual(len(reader.read_source(rev, store).units), 2)
            self.assertEqual(parsed.call_count, 3)
            # Changing the registered digest invalidates the cache rather than using stale bytes.
            store.nodes[rev]["details_json"]["sha256"] = "f" * 64
            with self.assertRaises(RecordError):
                run(units[1])

    def test_partition_cache_write_failure_logs_once_and_preparation_succeeds(self):
        from unittest.mock import Mock

        rev = "fixture-tbesh/1"
        store = Store({rev: HEBREW.encode()})
        store.write_partition_cache = Mock(side_effect=OSError("cache unavailable"))
        coord = "language-aids/tbesh/1"
        units = [
            {
                "unit_id": f"prepare-{i:03d}",
                "kind": "prepare",
                "native_extent": {
                    "unit_ids": [f"p{i:03d}"],
                    "coordinate_version": coord,
                },
                "depends_on": [],
            }
            for i in range(2)
        ]
        reader = AidRecipe(
            {"native_extent": {"coordinate_version": coord}, "units": units},
            "tbesh",
            STEP,
            rev,
            "lexicon_entry",
            2,
        )
        job = {
            "kind": "prepare",
            "unit_id": units[0]["unit_id"],
            "native_extent": units[0]["native_extent"],
            "input_refs": [{"kind": "source_revision", "id": rev}],
        }
        expected = reader.prepare(job, Store({rev: HEBREW.encode()}))
        with self.assertLogs(
            "css_preparation.adapters.step_aids", level="WARNING"
        ) as logs:
            actual = reader.prepare(job, store)
        self.assertEqual(store.write_partition_cache.call_count, 2)
        self.assertEqual(len(logs.records), 1)
        self.assertIn("Partition cache write failed", logs.output[0])
        self.assertEqual(actual.statements(), expected.statements())
        self.assertEqual(actual.blobs, expected.blobs)

    def test_original_digest_is_checked(self):
        rev = "fixture-tbesh/1"
        store = Store({rev: HEBREW.encode()})
        store.blobs["synthetic/" + rev] = b"changed"
        recipe_, unit = recipe("tbesh", STEP, rev)
        with self.assertRaises(RecordError):
            recipe_.prepare(
                {
                    "kind": "prepare",
                    "unit_id": unit["unit_id"],
                    "native_extent": unit["native_extent"],
                    "input_refs": [{"kind": "source_revision", "id": rev}],
                },
                store,
            )


if __name__ == "__main__":
    unittest.main()
