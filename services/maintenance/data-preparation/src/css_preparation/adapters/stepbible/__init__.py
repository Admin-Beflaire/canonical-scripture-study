"""STEPBible tagged-text adapter (TAHOT Hebrew OT, TAGNT Greek NT).

One recipe covers one book: an acquire unit for the pinned component file, prepare units of
whole verses sized for one D1 batch each, and a quality unit over the book. The adapter code
is generic; the recipe pins the exact file.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import tempfile
from typing import Any, Mapping

from ...acquire.transfer import Route, TransferError, transfer
from ...executor.checkpoints import RetryableUnitError
from ...prepare.evidence import NativeText
from ...prepare.records import RecordError, RecordSet
from .. import AdapterDeclaration, AdapterRegistry
from .prepare import METHOD_VERSION, book_text, book_verses, prepare_unit, read_component
from .source import BOOKS, RAW_HOST, Component

INPUT_FORMAT = 'stepbible/tagged-tsv'
CAPABILITIES = ('source_context', 'word_exact', 'form_exact', 'lemma_exact', 'grammar_exact')
DECLARATION = AdapterDeclaration(
    'stepbible-tagged', METHOD_VERSION, frozenset({INPUT_FORMAT}), frozenset(CAPABILITIES),
    frozenset({'source', 'commit', 'component', 'path', 'sha256', 'byte_count'}),
    ('Verses follow the declared base text; other readings are annotations, not alternative texts',
     'Paragraph markers are kept in the wording but are not yet literary-unit spans',
     'Word analyses are the source\'s own tags, attributed to STEPBible.org'))


def registry() -> AdapterRegistry:
    adapters = AdapterRegistry()
    adapters.register(DECLARATION)
    return adapters


@dataclass(frozen=True)
class BookRecipe:
    """Module entry points for one reviewed STEPBible book recipe."""

    recipe: Mapping[str, Any]
    component: Component
    book: str

    @classmethod
    def from_recipe(cls, recipe: Mapping[str, Any]) -> 'BookRecipe':
        registry().resolve(dict(recipe))
        component = Component.from_parameters(recipe['parameters'])
        extent = recipe['native_extent']
        book = extent.get('book')
        if (book not in BOOKS[component.source.key] or set(extent) != {'book', 'coordinate_version'}
                or extent['coordinate_version'] != component.coordinate_version
                or recipe.get('dependencies') != [component.acquisition_id]):
            raise RecordError(f"Recipe {recipe['id']} does not match its STEPBible component")
        return cls(recipe, component, book)

    # Gate --------------------------------------------------------------------
    def declares(self, reference: Mapping[str, Any], kind: str) -> bool:
        """Inputs this reviewed recipe vouches for before they are saved.

        The acquisition route is declared here. The source revision is accepted unsaved only
        by the acquire unit, which creates it; later units need the saved revision.
        """
        component = self.component
        if reference.get('kind') == 'acquisition':
            return (reference.get('id') == component.acquisition_id
                    and reference.get('sha256', component.sha256) == component.sha256
                    and reference.get('byte_count', component.byte_count) == component.byte_count)
        return (kind == 'acquire' and reference.get('kind') == 'source_revision'
                and reference.get('id') == component.revision_id and set(reference) == {'kind', 'id'})

    def _check_inputs(self, job: Mapping[str, Any]) -> None:
        refs = {(ref['kind'], ref['id']) for ref in job['input_refs']}
        if not {('acquisition', self.component.acquisition_id),
                ('source_revision', self.component.revision_id)} <= refs:
            raise RecordError('The task does not name this recipe\'s acquisition and source revision')

    # Units -------------------------------------------------------------------
    def acquire(self, job: Mapping[str, Any], storage: Any) -> RecordSet:
        """Retain the pinned original privately and register its source and admission records."""
        self._check_inputs(job)
        component = self.component
        key = component.original_key
        try:
            component.check_original(storage.read_blob(key))
        except (KeyError, RecordError):
            route = Route(component.acquisition_id, component.url, frozenset({RAW_HOST}),
                          component.byte_count, component.sha256)
            with tempfile.TemporaryDirectory() as directory:
                try:
                    result = transfer(route, Path(directory) / 'original')
                except TransferError as error:
                    raise RecordError(f'Acquisition failed: {error}') from None
                if not result.complete:
                    raise RetryableUnitError('Transfer interrupted')
                data = component.check_original(result.path.read_bytes())
            storage.put_blob(key, data)
            component.check_original(storage.read_blob(key))
        records = RecordSet()
        for row in component.identity().rows():
            records.add('source_node', row)
        records.add('admission', component.admission_row())
        return records

    def _original(self, storage: Any) -> bytes:
        try:
            return self.component.check_original(storage.read_blob(self.component.original_key))
        except KeyError:
            raise RecordError('The original has not been acquired') from None

    def prepare(self, job: Mapping[str, Any], storage: Any) -> RecordSet:
        self._check_inputs(job)
        extent = job['native_extent']
        if extent.get('coordinate_version') != self.component.coordinate_version:
            raise RecordError('Prepare unit uses other coordinates')
        return prepare_unit(self._original(storage), self.component, self.book, extent.get('unit_ids') or [])

    def read_source(self, revision: str, storage: Any) -> NativeText:
        if revision != self.component.revision_id:
            raise RecordError('Quality asked for another source revision')
        words = read_component(self._original(storage), self.component)
        return book_text(book_verses(words, self.component, self.book), self.component, self.book)
