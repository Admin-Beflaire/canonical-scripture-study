"""Build USFM native spans, wording and exact word postings."""

from ...indexes.files import PAGE_CAP, build_index_files
from ...indexes.source import build_source_postings
from ...prepare.evidence import NativeText, OutputBasis, SourceIdentity, SpanSpec
from ...prepare.evidence import build_evidence
from ...prepare.records import D1_BATCH_LIMIT, RecordError, RecordSet
from ...indexes.english import ENGLISH_EXACT
from .source import USFM_BOOK_STRIDE

METHOD = "usfm-text/1"
CAPABILITIES = ("source_context", "word_exact")


def _spans(text: NativeText):
    for unit, body in text.units:
        number = unit.removesuffix(".title")
        book, chapter, verse = number.split(".")
        title = unit != number
        label = f"{book} {chapter}:{verse}"
        yield SpanSpec(
            unit,
            "superscription" if title else "verse",
            label + " title" if title else label,
            ((unit, 0, len(body)),),
            "extracted",
            {"usfm_marker": "d" if title else "v"},
        )


def prepare_text(
    identity: SourceIdentity, text: NativeText, parameters: dict[str, str]
) -> RecordSet:
    revisions = (identity.revision.id,)
    units = [unit for unit, _ in text.units]
    extent = {"coordinate_version": text.coordinate_version, "unit_ids": units}
    evidence_basis = OutputBasis("evidence", revisions, METHOD, parameters, extent)
    records = build_evidence(
        identity, text, _spans(text), evidence_basis, d1_body_max_bytes=0
    )
    basis = OutputBasis(
        "source_search",
        revisions,
        METHOD,
        {
            "tokenizer_version": ENGLISH_EXACT.tokenizer_version,
            "normalization_rule": ENGLISH_EXACT.normalization_rule,
            "index_routing": "key-output/1",
        },
        extent,
        (evidence_basis.output_id,),
    )
    for part in build_source_postings(
        text,
        records,
        basis,
        ENGLISH_EXACT,
        max_units=len(units),
        max_scalars=USFM_BOOK_STRIDE - 1,
        max_occurrences=200_000,
        encoded_page_cap_bytes=PAGE_CAP,
    ):
        if part.postings:
            records.merge(
                build_index_files(part, encoded_page_cap_bytes=PAGE_CAP).records
            )
    if len(records.statements()) > D1_BATCH_LIMIT:
        raise RecordError("USFM prepare unit exceeds one D1 batch")
    return records
