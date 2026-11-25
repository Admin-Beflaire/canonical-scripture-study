"""A unit saves its outputs, retries within a bound and reports failures safely (synthetic only)."""

from dataclasses import replace
import hashlib
import json
from pathlib import Path
import unittest

from css_preparation.executor import ControlState, UnitNotRunnableError
from css_preparation.executor.candidate import CandidateStore
from css_preparation.executor.unit import (
    RetryableUnitError,
    StopWorkError,
    run_unit,
)
from css_preparation.prepare.records import (
    ReaderBoundaryError,
    RecordError,
    decoded,
    TABLES,
)
from css_preparation.provider import ProviderError
from preparation_fixture import COORDINATES, database, evidence_a, text_a

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[1] / "conformance/maintenance-jobs.v1.json"
    ).read_text()
)


class UnitRun(unittest.TestCase):
    def setUp(self):
        self.db = database()
        self.addCleanup(self.db.close)
        self.blobs = {}
        self.work_count = 0
        self.selection = [
            tuple(r) for r in self.db.execute("SELECT * FROM release_selection")
        ]
        self.storage = CandidateStore(
            self.put, self.read, self.write, self.find, self.all_rows
        )
        self.state = None
        self.job = dict(FIXTURE["valid"]["job_input"][0])
        self.job["input_refs"] = [
            {"kind": "source_revision", "id": "synthetic:a:revision-1"}
        ]
        self.job["native_extent"] = {
            "unit_ids": [u for u, _ in text_a().units],
            "coordinate_version": COORDINATES,
        }

    def put(self, key, data):
        if key in self.blobs and self.blobs[key] != data:
            raise RecordError("Cannot overwrite immutable artifact")
        self.blobs[key] = bytes(data)

    def read(self, key):
        return self.blobs[key]

    def write(self, statements):
        with self.db:
            for sql, values in statements:
                self.db.execute(sql, values)

    def find(self, kind, identifier):
        table = {"prepared_output": "prepared_outputs", "artifact": "artifacts"}[kind]
        rows = decoded(
            self.db.execute(
                f"SELECT * FROM {table} WHERE id = ?", (identifier,)
            ).fetchall()
        )
        return rows[0] if rows else None

    def all_rows(self, kind, *_):
        return decoded(self.db.execute("SELECT * FROM " + TABLES[kind]).fetchall())

    def build(self, _):
        self.work_count += 1
        return evidence_a()

    def invoke(
        self,
        *,
        job=None,
        builder=None,
        max_retries=1,
        registry=None,
        control=None,
    ):
        job = self.job if job is None else job
        raw = json.dumps(job, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        self.state = ControlState(
            job["task_id"],
            job["task_revision"] + 1,
            "running",
            job["basis_digest"],
            job["unit_id"],
            job["attempt"],
            job["task_revision"],
            hashlib.sha256(raw.encode("utf-8")).hexdigest(),
            "run-9",
            "dispatched",
        )

        def reader(*_):
            return self.state if control is None else control()

        handler = builder or self.build
        return run_unit(
            raw,
            run_id="run-9",
            read_control=reader,
            registered=registry or (lambda _: True),
            acquire=handler,
            prepare=handler,
            quality=handler,
            storage=self.storage,
            max_retries=max_retries,
        )

    def test_a_unit_saves_its_outputs_and_reports_them(self):
        first = self.invoke()
        self.assertEqual(first.state, "saved")
        self.assertEqual(first.completed_extent, self.job["native_extent"])
        self.assertEqual(first.remaining_extent, {})
        self.assertEqual(first.saved.output_ids, tuple(evidence_a().output_ids()))
        self.assertEqual(self.work_count, 1)
        self.assertEqual(
            [tuple(r) for r in self.db.execute("SELECT * FROM release_selection")],
            self.selection,
        )

    def test_rerunning_a_saved_unit_saves_nothing_twice(self):
        first = self.invoke()
        again = self.invoke()
        self.assertEqual(again.state, "saved")
        self.assertEqual(again.saved, first.saved)
        self.assertEqual(self.work_count, 2)
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM prepared_outputs").fetchone()[0], 1
        )
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM releases").fetchone()[0], 0
        )

    def test_a_damaged_saved_artifact_is_never_reported_as_saved(self):
        result = self.invoke()
        artifact_ref = result.saved.artifact_refs[0]
        locator = self.find("artifact", artifact_ref["artifact_id"])[
            "registered_locator"
        ]
        self.blobs[locator] = b"damaged"
        check = self.invoke()
        self.assertEqual(check.state, "failed")
        self.assertEqual(check.completed_extent, {})
        self.assertEqual(check.remaining_extent, self.job["native_extent"])
        self.assertEqual(check.diagnostics, ("invalid_or_unavailable_output",))
        self.assertEqual(
            [tuple(r) for r in self.db.execute("SELECT * FROM release_selection")],
            self.selection,
        )

    def test_missing_saved_coverage_is_not_reported_as_saved(self):
        def incomplete(kind, *_):
            rows = self.all_rows(kind)
            return [] if kind == "coverage" else rows

        self.storage = replace(self.storage, read_rows=incomplete)
        result = self.invoke()
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.diagnostics, ("invalid_or_unavailable_output",))

    def test_rejects_different_revision_or_extent_before_persistence(self):
        changed = {
            **self.job,
            "input_refs": [{"kind": "source_revision", "id": "other-revision"}],
        }
        rejected = self.invoke(job=changed)
        self.assertEqual(rejected.state, "failed")
        self.assertEqual(rejected.completed_extent, {})
        changed = {**self.job, "native_extent": {"unit_ids": ["unrelated"]}}
        rejected = self.invoke(job=changed)
        self.assertEqual(rejected.state, "failed")
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM prepared_outputs").fetchone()[0], 0
        )

    def test_paused_or_cancelled_task_stops_without_new_candidate_writes(self):
        for state in ("paused", "cancelled", "superseded"):
            with self.subTest(state=state):
                with self.assertRaises(UnitNotRunnableError):
                    self.invoke(
                        control=lambda state=state: replace(
                            self.state, task_state=state
                        ),
                        builder=lambda _: self.fail("task not eligible"),
                    )
                self.assertEqual(self.work_count, 0)

        def change_state(_):
            self.state = replace(self.state, task_state="paused", task_revision=3)
            return evidence_a()

        with self.assertRaises(UnitNotRunnableError):
            self.invoke(builder=change_state)
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM prepared_outputs").fetchone()[0], 0
        )

    def test_retry_rechecks_control_and_avoids_rerunning_cancelled_unit(self):
        calls = []

        def transient(_):
            calls.append("called")
            self.state = replace(self.state, task_state="cancelled", task_revision=3)
            raise RetryableUnitError("synthetic timeout")

        result = self.invoke(builder=transient)
        self.assertEqual(result.state, "failed")
        self.assertEqual(result.diagnostics, ("stopped",))
        self.assertEqual(calls, ["called"])

    def test_bounded_transient_retry_and_refusal_limit_diagnostics(self):
        attempts = []

        def once(_):
            attempts.append(1)
            if len(attempts) == 1:
                raise RetryableUnitError("retry once")
            return evidence_a()

        result = self.invoke(builder=once)
        self.assertEqual(result.state, "saved")
        self.assertEqual(len(attempts), 2)
        for reason in ("quota", "refused", "missing_dependency", "limit"):
            with self.subTest(reason=reason):

                def stop(_, reason=reason):
                    raise StopWorkError(reason)

                failed = self.invoke(builder=stop)
                self.assertEqual(failed.diagnostics, (reason,))
                self.assertEqual(failed.remaining_extent, self.job["native_extent"])
                self.assertIsNone(failed.saved)
        with self.assertRaises(ValueError):
            self.invoke(max_retries=4)

    def record(self, progress):
        """The safe error record in a failed unit's diagnostic detail."""
        return json.loads(progress.diagnostic_detail)

    def test_exhausted_transient_and_permanent_failure_claim_no_progress(self):
        calls = []

        def never(_):
            calls.append(1)
            raise RetryableUnitError("unavailable")

        failed = self.invoke(builder=never, max_retries=2)
        self.assertEqual(failed.diagnostics, ("transient_exhausted",))
        self.assertEqual(
            (self.record(failed)["stage"], self.record(failed)["error"]),
            ("building_output", "RetryableUnitError"),
        )
        self.assertNotIn("message", self.record(failed))
        self.assertEqual(len(calls), 3)
        self.assertEqual(failed.completed_extent, {})

        def permanent(_):
            raise OSError("contains secret details; never copy to diagnostics")

        failed = self.invoke(builder=permanent)
        self.assertEqual(failed.diagnostics, ("invalid_or_unavailable_output",))
        self.assertEqual(
            (self.record(failed)["stage"], self.record(failed)["error"]),
            ("building_output", "OSError"),
        )
        self.assertNotIn("secret", failed.diagnostic_detail)
        self.assertEqual(
            self.db.execute("SELECT COUNT(*) FROM prepared_outputs").fetchone()[0], 0
        )

    def test_reader_boundary_reports_only_validated_reference(self):
        def split(_):
            raise ReaderBoundaryError("1Ch.12.5")

        failed = self.invoke(builder=split)
        self.assertEqual(failed.diagnostics, ("reader_boundary",))
        self.assertEqual(
            self.record(failed)["message"],
            "Reader marker 1Ch.12.5 crosses the requested native unit boundary",
        )
        with self.assertRaises(RecordError) as caught:
            ReaderBoundaryError("1Ch.12.5 secret=bad")
        self.assertIs(type(caught.exception), RecordError)

    def test_control_failure_on_retry_reports_control_stage(self):
        checks = []
        attempts = []

        def control():
            checks.append(1)
            if len(checks) == 3:
                raise OSError("private detail")
            return self.state

        def once(_):
            attempts.append(1)
            if len(attempts) == 1:
                raise RetryableUnitError("retry")
            return evidence_a()

        result = self.invoke(control=control, builder=once)
        self.assertEqual(self.record(result)["stage"], "control_check")
        self.assertNotIn("private", result.diagnostic_detail)

    def test_a_storage_provider_error_retains_stage_and_status(self):
        for transient in (True, False):
            with self.subTest(transient=transient):
                calls = []

                def refuse(key, data, calls=calls, transient=transient):
                    calls.append(1)
                    raise ProviderError(
                        "Storage write refused", status=503, transient=transient
                    )

                self.storage = replace(self.storage, put_blob=refuse)
                result = self.invoke()
                self.assertEqual(result.diagnostics, ("provider_failure",))
                record = self.record(result)
                self.assertEqual(
                    (record["stage"], record["http"], record["message"]),
                    ("saving_output", 503, "Storage write refused"),
                )
                self.assertEqual(len(calls), 1)

    def test_acquisition_failure_reports_stage_and_tool(self):
        def fail(_):
            raise OSError("secret source detail")

        result = self.invoke(job={**self.job, "kind": "acquire"}, builder=fail)
        record = self.record(result)
        self.assertEqual(
            (record["tool"], record["stage"], record["error"]),
            ("acquire", "acquiring_input", "OSError"),
        )
        self.assertNotIn("secret", result.diagnostic_detail)

    def test_the_record_names_the_unit_and_never_holds_foreign_text(self):
        def fail(_):
            raise RecordError(
                "Gen.3 line 1204, field morph: expected a morphology code"
            )

        record = self.record(self.invoke(builder=fail))
        self.assertEqual(record["ids"]["unit"], self.job["unit_id"])
        self.assertEqual(
            record["message"],
            "Gen.3 line 1204, field morph: expected a morphology code",
        )


if __name__ == "__main__":
    unittest.main()
