"""Book extents and retained source inputs for USFM recipes."""

from dataclasses import dataclass
import hashlib
from typing import Any, Mapping

from ...acquire.archive import archive_member
from ...prepare.evidence import NativeText, SourceIdentity, canonical_digest
from ...prepare.records import RecordError
from ...recipe_source import COLLECTION, read_json, source_variables
from ...recipe_templates import native_units
from ..acquire_only import AcquireRecipe
from ..retained import retained_identity
from .text import read_book

USFM_BOOK_STRIDE = 2**32


def book_units(book: str, config: Mapping[str, Any]) -> list[str]:
    verses = native_units(book, config["chapters"])
    titles = {f"{book}.{anchor}" for anchor in config.get("titles_before", ())}
    if not titles.issubset(verses):
        raise RecordError("Descriptive title falls outside the reviewed USFM extent")
    return [
        entry
        for verse in verses
        for entry in ((verse + ".title", verse) if verse in titles else (verse,))
    ]


def preparation_basis(
    variables: Mapping[str, Any], manifest: Mapping[str, Any], book: str, reader: bool
) -> str:
    config = variables["books"][book]
    return canonical_digest(
        {
            "manifest": manifest,
            "retained_original": variables["analysis_report"],
            "coordinate_version": variables["coordinate_version"],
            "native_scheme": variables["native_scheme"],
            "book_order": list(variables["books"]),
            "book": book,
            "unit_order": book_units(book, config),
            "member": config["member"],
            "sha256": config["sha256"],
            "usfm_code": config.get("usfm_code", book.upper()),
            **(
                {
                    "editorial_headings_before": sorted(
                        config["editorial_headings_before"]
                    )
                }
                if config.get("editorial_headings_before")
                else {}
            ),
            **({"mapping": config["reader_mapping"]} if reader else {}),
        }
    )


@dataclass(frozen=True)
class UsfmSource:
    variables: Mapping[str, Any]
    acquisition: AcquireRecipe
    book: str
    config: Mapping[str, Any]
    ordinal: int

    @classmethod
    def from_parameters(cls, parameters: Mapping[str, Any], book: str) -> "UsfmSource":
        name = parameters["variables"]
        if (
            not isinstance(name, str)
            or not name
            or not all(c.isascii() and (c.isalnum() or c == "-") for c in name)
        ):
            raise RecordError("Invalid USFM variables name")
        variables = source_variables(name)
        books = variables["books"]
        receipt = variables["analysis_report"]
        if (
            variables["kind"] != "usfm-text"
            or book not in books
            or parameters["archive_sha256"] != receipt["archive_sha256"]
            or parameters["member_sha256"] != books[book]["sha256"]
        ):
            raise RecordError("USFM recipe does not match its pinned source and member")
        fetch = AcquireRecipe.from_recipe(
            read_json(COLLECTION / "recipes" / f"{name}.json")
        )
        if fetch.recipe["parameters"]["manifest"] != variables["manifest"]:
            raise RecordError("USFM variables refer to a different retained original")
        return cls(variables, fetch, book, books[book], list(books).index(book))

    @property
    def revision(self) -> str:
        return self.acquisition.manifest["source_revision"]

    @property
    def coordinate(self) -> str:
        return self.variables["coordinate_version"]

    def checked_text(self, storage: Any) -> NativeText:
        receipt = self.variables["analysis_report"]
        archive, _ = self.acquisition.read_kept_original(
            storage,
            sha256=receipt["archive_sha256"],
            byte_count=receipt["archive_bytes"],
        )
        data = archive_member(archive, self.config["member"])
        if hashlib.sha256(data).hexdigest() != self.config["sha256"]:
            raise RecordError("USFM member differs from the reviewed original")
        verses, titles = read_book(
            data,
            self.book,
            self.config.get("usfm_code", self.book.upper()),
            editorial_headings_before=self.config.get("editorial_headings_before", ()),
        )
        ordered = {
            entry: body
            for unit, verse in verses.items()
            for entry, body in (
                ((unit + ".title", titles[unit + ".title"]), (unit, verse))
                if unit + ".title" in titles
                else ((unit, verse),)
            )
        }
        if not all(ordered.values()) or list(ordered) != book_units(
            self.book, self.config
        ):
            raise RecordError("USFM book does not match the reviewed native extent")
        position = self.ordinal * USFM_BOOK_STRIDE
        offsets = []
        for body in ordered.values():
            offsets.append(position)
            position += len(body)
        return NativeText(
            self.coordinate, tuple(ordered.items()), order_bases=tuple(offsets)
        )

    def identity(self, storage: Any) -> SourceIdentity:
        return retained_identity(storage, self.revision)

    def select(self, text: NativeText, units: list[str]) -> NativeText:
        bases = text.scalar_bases()
        return NativeText(
            text.coordinate_version,
            tuple((unit, text.unit(unit)) for unit in units),
            order_bases=tuple(bases[unit] for unit in units),
        )
