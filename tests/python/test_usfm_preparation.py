"""USFM preparation, saved quality and reference offsets with invented text."""

from copy import deepcopy
import hashlib
import json
import unittest
from unittest.mock import patch

from css_preparation.adapters.usfm.prepare import prepare_text
from css_preparation.adapters.usfm.reader import prepare_reader
from css_preparation.adapters.usfm.text import read_book
from css_preparation.prepare.evidence import (
    NativeText,
    OutputBasis,
    canonical_digest,
    span_wording,
)
from css_preparation.prepare.records import RecordError, decoded, scoped_query
from css_preparation.validate.saved import CandidateInventory
from css_preparation.validate.semantic import check_saved_semantics
from preparation_fixture import database, identity, save


def _bases(records):
    return tuple(
        OutputBasis(
            row["kind"],
            tuple(row["input_revisions_json"]),
            row["method_version"],
            row["parameters_json"],
            row["native_extent_json"],
            tuple(row["validation_basis_json"]["dependencies"]),
        )
        for row in records.rows("prepared_output")
    )


class UsfmPreparationTest(unittest.TestCase):
    def test_saved_native_verse_and_title_keep_exact_spelling(self):
        raw = r"""\id PSA
\c 1
\ms1 Discarded
\d \w Title|lemma="ignored"\w* words
\q1
\v 1 \wj \+w Love|ignored="attributes"\+w*\wj*; love, well-known King's King’s é é.\f + \ft footnote\f*
\q2 \qs Selah\qs*
\x + \xt crossreference\x*
\d Another heading
\v 2 Plain text.
""".encode()
        verses, titles = read_book(raw, "Psa", "PSA")
        title, verse = "Psa.1.1.title", "Psa.1.1"
        text = NativeText(
            "usfm-fixture/1",
            (
                (title, titles[title]),
                (verse, verses[verse]),
                ("Psa.1.2.title", titles["Psa.1.2.title"]),
                ("Psa.1.2", verses["Psa.1.2"]),
            ),
        )
        source = identity("usfm")
        records = prepare_text(source, text, {"source_basis": "fixture"})
        spans = {
            row["kind"] + ":" + row["segments_json"][0]["unit_id"]: row
            for row in records.rows("native_span")
        }
        self.assertEqual(
            span_wording(spans["verse:Psa.1.1"], {}, records.blobs),
            ["Love; love, well-known King's King’s é é. Selah"],
        )
        postings = {
            row["search_key"]: row
            for artifact in records.rows("artifact")
            if artifact["format"] == "application/x-ndjson"
            for line in records.blobs[artifact["id"]].splitlines()
            if (row := json.loads(line))
        }
        self.assertEqual(
            set(postings),
            {
                "Title",
                "words",
                "Love",
                "love",
                "well-known",
                "King's",
                "King’s",
                "Selah",
                "é",
                "é",
                "Another",
                "heading",
                "Plain",
                "text",
            },
        )
        self.assertEqual(
            postings["Title"]["span_id"], spans["superscription:Psa.1.1.title"]["id"]
        )
        self.assertEqual(
            postings["Title"]["native_reference"]["segments"],
            [{"unit_id": title, "start": 0, "end": 5}],
        )
        self.check_saved(source, text, records, ["source_context", "word_exact"])

    def check_saved(self, source, text, records, capabilities, rebuild=None):
        db = database()
        self.addCleanup(db.close)
        save(records, db)
        blobs = {
            row["registered_locator"]: records.blobs[row["id"]]
            for row in records.rows("artifact")
        }
        result = check_saved_semantics(
            {
                "input_refs": [{"kind": "source_revision", "id": source.revision.id}],
                "native_extent": {
                    "coordinate_version": text.coordinate_version,
                    "unit_ids": [unit for unit, _ in text.units],
                },
                "required_capabilities": capabilities,
            },
            CandidateInventory(added=_bases(records)),
            read_rows=lambda kind, ids: decoded(
                db.execute(*scoped_query(kind, ids)).fetchall()
            ),
            read_blob=blobs.__getitem__,
            read_source=lambda _: text,
            read_reader_references=rebuild,
        )
        self.assertEqual(set(result.capabilities), set(capabilities))
        return result

    def test_saved_reader_split_and_explicit_gap_use_only_checked_spans(self):
        # A miniature catalogue and native numbering with the same cross-chapter split shape.
        catalogue = {"reader_scheme_version": "nrsva/1"}
        reader = {"book_id": "Rev", "last_verses": [2, 2]}
        text = NativeText(
            "usfm-fixture/1", (("Rev.1.1", "One."), ("Rev.2.1", "Two. Three."))
        )
        resolution = {
            "scheme": "nrsva/1",
            "catalogue_sha256": canonical_digest(catalogue),
            "profile": "synthetic",
            "native_profile_last_verses": [1, 1],
            "evidence": {},
            "checked_text_sha256": {
                "Rev.2.1": hashlib.sha256(b"Two. Three.").hexdigest()
            },
            "candidates": {"Rev.1.2": {"checked_native": ["Rev.2.1"]}},
            "links": {
                "Rev.1.2": {"finding": "Rev.1.2", "segments": [["Rev.2.1", 0, 4]]},
                "Rev.2.1": {"finding": "Rev.1.2", "segments": [["Rev.2.1", 5, 11]]},
                "Rev.2.2": {
                    "finding": "Rev.1.2",
                    "segments": [],
                    "scope_unit": "Rev.2.1",
                    "gap_reason": "No checked source counterpart",
                },
            },
        }
        source = identity("usfm")
        with patch(
            "css_preparation.adapters.usfm.reader.reader_catalogue",
            return_value=(catalogue, reader),
        ):

            def build(mapping):
                return prepare_reader(
                    source, "Rev", text, text, mapping, "fixture", "fixture"
                )

            records = build(resolution)
            spans = {
                row["label"]: span_wording(row, {}, records.blobs)
                for row in records.rows("native_span")
            }
            self.assertEqual(spans, {"Rev.1.2": ["Two."], "Rev.2.1": ["Three."]})
            result = self.check_saved(
                source, text, records, ["reader_reference"], lambda _: build(resolution)
            )
            self.assertTrue(any("Rev.2.2" in item for item in result.limitations))
            altered = deepcopy(resolution)
            altered["links"]["Rev.2.1"]["segments"][0][1] = 6
            with self.assertRaisesRegex(RecordError, "omit native wording"):
                build(altered)
