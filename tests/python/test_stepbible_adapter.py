"""DP-05a: STEPBible tagged-text adapter, recipes and runner gate (synthetic files only)."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import unittest
from unittest import mock

from css_preparation.adapters.stepbible import BookRecipe, DECLARATION
from css_preparation.adapters.stepbible.format import FormatError, join_forms, native_form, read_words
from css_preparation.adapters.stepbible.prepare import MAX_STATEMENTS, book_text, book_verses, prepare_unit, read_component
from css_preparation.adapters.stepbible.recipes import MAX_PREPARE_UNITS, MAX_VERSES, dumps
from css_preparation.adapters.stepbible.rules import RULES
from css_preparation.adapters.stepbible.source import BOOK_STRIDE, Component
from css_preparation.contracts import contract_errors
from css_preparation.prepare.evidence import NativeText
from css_preparation.prepare.records import RecordError
from css_preparation.runner import __main__ as runner
from css_preparation.runner.cloudflare import CloudflareConfig, CloudflareStorage
from css_preparation.runner.control import ControlClient, ControlConfig
from css_preparation.runner.recipes import RECIPES, Recipe, load_recipes
from css_preparation.runner.web import Origin
from runner_doubles import TOKEN_ID, LoopbackApi
import stepbible_fixture as fixture

ROOT = Path(__file__).resolve().parents[2]
WIRE = json.loads((ROOT / 'tests/conformance/dp04-control-wire.v1.json').read_text(encoding='utf-8'))
RUN_ID = '987654321'


class FormatTest(unittest.TestCase):
    def test_reads_only_word_rows_with_native_references(self):
        words = list(read_words(fixture.tahot_lines(), 'hebrew'))
        self.assertEqual([(w.unit_id, w.reference, w.number, w.text_type) for w in words][3:6], [
            ('Exo.1.1', 'Exo.1.1', 4, 'L'), ('Exo.1.3', 'Exo.1.2', 1, 'X'), ('Exo.1.3', 'Exo.1.2', 2, 'Q(K)')])
        self.assertEqual(native_form(words[0], 'hebrew'), 'אָבֹג')        # morpheme separators are not wording
        self.assertEqual(native_form(words[3], 'hebrew'), 'חַט׃ פ')
        greek = list(read_words(fixture.tagnt_lines(), 'greek'))
        self.assertEqual(native_form(greek[2], 'greek'), 'κἀγώ,')
        self.assertEqual([w.unit_id for w in greek], ['Mat.1.1'] * 4 + ['Mat.1.3', 'Mat.1.4'])

    def test_malformed_word_rows_stop_the_read(self):
        for bad in ('Exo.1.1#01=L\tonly three\tcells', 'Exo.1.1=L' + '\tx' * 16, 'Exo.1.1[1.2]#01=L' + '\tx' * 16):
            with self.subTest(bad=bad), self.assertRaises(FormatError):
                list(read_words([bad], 'hebrew'))
        with self.assertRaises(FormatError):
            native_form(next(read_words([fixture.row('Mat.1.1#01=N', 'no transliteration')], 'greek')), 'greek')

    def test_join_keeps_maqaf_words_together(self):
        self.assertEqual(join_forms(['אָבֹג', 'דֶה־', 'וָז', '', 'חַט׃'], 'hebrew'),
                         ('אָבֹג דֶה־וָז חַט׃', ((0, 5), (6, 10), (10, 13), (13, 13), (14, 18))))
        self.assertEqual(join_forms(['αβ', 'γδ'], 'greek')[0], 'αβ γδ')


class PrepareTest(unittest.TestCase):
    def test_hebrew_unit_marks_readings_and_indexes_words(self):
        component, raw = fixture.component('tahot')
        records = prepare_unit(raw, component, 'Exo', ['Exo.1.1', 'Exo.1.3'])
        spans = {row['label']: row for row in records.rows('native_span')}
        self.assertEqual(spans['Exo 1:1']['reading_kind'], 'extracted')
        self.assertEqual(spans['Exo 1:3']['basis_json']['english_references'], ['Exo.1.2'])
        self.assertEqual(spans['Exo 1:3 word 1']['reading_kind'], 'reconstructed')
        self.assertEqual(spans['Exo 1:1 word 3']['basis_json']['reading'], 'Qere (read) form')
        notes = {row['span_id'].rsplit('#', 1)[1]: row['details_json']['words'] for row in records.rows('annotation')}
        self.assertEqual(notes['Exo.1.1'], [{'row': 3, 'type': 'Q(K)', 'spelling_variants': 'K= וָזז (synthetic)'}])
        self.assertEqual(notes['Exo.1.3'], [{'row': 1, 'type': 'X'},
                                            {'row': 2, 'type': 'Q(K)', 'word': '', 'meaning_variants': 'K= לְמ (synthetic)'}])
        self.assertEqual({row['state'] for row in records.rows('coverage')}, {'available'})
        self.assertEqual({row['capability'] for row in records.rows('coverage')},
                         {'source_context', 'word_exact', 'form_exact', 'lemma_exact', 'grammar_exact'})
        # Exodus is book 2: its linear order starts after Genesis's whole range.
        segments = sorted(row['start_order'] for row in records.rows('span_segment'))
        self.assertEqual(segments[0], BOOK_STRIDE)
        postings = self._postings(records, 'word_index')
        lemmas = {row['search_key'] for row in postings if row['lookup_kind'] == 'lemma'}
        self.assertEqual(lemmas, {'lemma:H9002', 'lemma:H1234', 'lemma:H2222', 'lemma:H3333', 'lemma:H4444',
                                  'lemma:H5555', 'lemma:H66667'})
        grammar = {row['search_key'] for row in postings if row['lookup_kind'] == 'grammar'}
        self.assertIn('grammar:aramaic:Ncmsa', grammar)
        self.assertIn('grammar:hebrew:C', grammar)
        # Paragraph markers and punctuation are wording but not search tokens.
        source_keys = {row['search_key'] for row in self._postings(records, 'source_search')}
        self.assertEqual(len(source_keys), 6)
        self.assertFalse(source_keys & {'פ', '׃', '־'})
        self.assertLessEqual(len(records.statements()), MAX_STATEMENTS)

    def test_greek_unit_keeps_na28_words_and_annotates_the_rest(self):
        component, raw = fixture.component('tagnt')
        records = prepare_unit(raw, component, 'Mat', ['Mat.1.1', 'Mat.1.3', 'Mat.1.4'])
        text = book_text(book_verses(read_component(raw, component), component, 'Mat'), component, 'Mat')
        self.assertEqual(dict(text.units), {'Mat.1.1': 'Αβγ κἀγώ, δι᾽', 'Mat.1.3': 'ηθι.', 'Mat.1.4': ''})
        spans = {row['label']: row for row in records.rows('native_span')}
        self.assertEqual(spans['Mat 1:4']['reading_kind'], 'gap')
        notes = {row['span_id'].rsplit('#', 1)[1]: row['details_json']['words'] for row in records.rows('annotation')}
        self.assertEqual(notes['Mat.1.1'], [
            {'row': 1, 'type': 'NKO', 'editions': 'NA28+NA27+TR+Byz'},
            {'row': 2, 'type': 'K', 'word': 'δεζ', 'editions': 'TR+Byz', 'gloss': 'second', 'tags': 'G2222=V-PAI-3S'},
            # A base word placed elsewhere in one edition keeps the displacement note.
            {'row': 3, 'type': 'NKO', 'editions': 'NA28+NA27+TR«4+Byz', 'meaning_variants': 'synthetic meaning variant'},
            # A base word missing from some editions keeps its edition list.
            {'row': 4, 'type': 'NKO', 'editions': 'NA28+TR'}])
        self.assertEqual(notes['Mat.1.3'], [{'row': 1, 'type': 'NKO', 'editions': 'NA28+TR'}])
        self.assertEqual(notes['Mat.1.4'][0]['word'], 'λμν')
        postings = self._postings(records, 'word_index')
        crasis = {row['search_key'] for row in postings if row['form'] == 'κἀγώ'}
        self.assertTrue({'lemma:G2532', 'lemma:G1473', 'form:καγω', 'grammar:greek:P-1NS'} <= crasis)
        self.assertIn('lemma:G20447', {row['search_key'] for row in postings})
        self.assertIn('δι’', {row['search_key'] for row in self._postings(records, 'source_search')})
        self.assertEqual({row['state'] for row in records.rows('coverage')}, {'available'})

    def test_word_present_in_every_edition_needs_no_annotation(self):
        lines = fixture.tagnt_lines()
        lines[-2] = fixture.row('Mat.1.2(1.3)#01=NKO', 'ηθι. (ēthi)', 'there', 'G3333=ADV', 'ηθι=there',
                                'NA28+NA27+Tyn+SBL+WH+Treg+TR+Byz')
        component, raw = fixture.component('tagnt', lines)
        self.assertEqual(prepare_unit(raw, component, 'Mat', ['Mat.1.3']).rows('annotation'), [])

    def test_two_words_in_one_hebrew_row_stay_two_words(self):
        lines = fixture.tahot_lines()
        lines[-1] = fixture.row('Exo.1.2(1.3)#03=Q(K)', 'בָּא//גָד\\׃', 'ba gad', 'fortune came',
                                '{H0935G}//{H1409}\\H9016', 'HVqp3ms//Ncmsa')
        component, raw = fixture.component('tahot', lines)
        text = book_text(book_verses(read_component(raw, component), component, 'Exo'), component, 'Exo')
        self.assertEqual(text.unit('Exo.1.3'), 'יָכ בָּא גָד׃')
        records = prepare_unit(raw, component, 'Exo', ['Exo.1.3'])
        words = {row['form']: row for row in self._postings(records, 'word_index') if row['lookup_kind'] == 'lemma'}
        self.assertEqual(set(words), {'יָכ', 'בָּא', 'גָד'})
        self.assertEqual({a['lemma_id'] for a in words['גָד']['analyses']}, {'H0935G', 'H1409'})

    def test_untagged_word_is_reported_as_partial_word_coverage(self):
        lines = fixture.tagnt_lines()
        lines[-6] = fixture.row('Mat.1.1#01=NKO', 'Αβγ (Abg)', 'first', 'untagged', '', 'NA28')
        component, raw = fixture.component('tagnt', lines)
        records = prepare_unit(raw, component, 'Mat', ['Mat.1.1'])
        states = {row['capability']: row['state'] for row in records.rows('coverage')}
        self.assertEqual(states['source_context'], 'available')
        self.assertEqual(states['lemma_exact'], 'partial')

    def test_refuses_altered_originals_and_foreign_verses(self):
        component, raw = fixture.component('tahot')
        with self.assertRaisesRegex(RecordError, 'differs from the pinned'):
            prepare_unit(raw + b' ', component, 'Exo', ['Exo.1.1'])
        for book, units in (('Exo', ['Exo.9.9']), ('Exo', []), ('Exo', ['Exo.1.1', 'Exo.1.1']), ('Gen', ['Gen.1.1'])):
            with self.subTest(units=units), self.assertRaises(RecordError):
                prepare_unit(raw, component, book, units)

    def test_order_bases_are_checked(self):
        NativeText('c', (('a', 'xy'), ('b', 'z')), order_bases=(10, 12))
        for bases in ((10, 11), (5,), (-1, 3), (2**53, 2**53 + 5)):
            with self.subTest(bases=bases), self.assertRaises(RecordError):
                NativeText('c', (('a', 'xy'), ('b', 'z')), order_bases=bases)

    def test_search_rules(self):
        hebrew, greek = RULES['hebrew'], RULES['greek']
        text = 'אָ֣בֹג דֶה־וָז׃ פ'
        self.assertEqual([text[s:e] for s, e in hebrew.tokenize(text)], ['אָ֣בֹג', 'דֶה', 'וָז'])
        self.assertEqual(hebrew.normalize('אָ֣בֹג'), 'אָבֹג')
        text = 'Ἰησοῦ, δι᾽ αὐτοῦ·'
        self.assertEqual([text[s:e] for s, e in greek.tokenize(text)], ['Ἰησοῦ', 'δι᾽', 'αὐτοῦ'])
        self.assertEqual(greek.normalize('Ἰησοῦς'), 'ιησουσ')

    @staticmethod
    def _postings(records, kind):
        rows = []
        for artifact in records.rows('artifact'):
            if artifact['format'] == 'application/x-ndjson' and artifact['output_id'].startswith(kind):
                rows.extend(json.loads(line) for line in records.blobs[artifact['id']].splitlines())
        return rows


class RecipeTest(unittest.TestCase):
    def test_committed_recipes_resolve_and_fit_control_limits(self):
        recipes = load_recipes()
        self.assertEqual(len(recipes), 66)
        manifest = json.loads((ROOT / 'collection/manifests/stepbible-data-5de0a47f35f0.json').read_text())
        pinned = {item['component']: item for item in manifest['components']}
        for path in sorted((ROOT / 'collection/recipes').glob('stepbible-*.json')):
            with self.subTest(recipe=path.stem):
                value = json.loads(path.read_text(encoding='utf-8'))
                self.assertEqual(path.read_text(encoding='utf-8'), dumps(value))
                book = BookRecipe.from_recipe(value)
                component = book.component
                self.assertEqual((component.sha256, component.byte_count),
                                 (pinned[component.component]['sha256'], pinned[component.component]['byte_count']))
                self.assertEqual(value['manifest_revision'], manifest['manifest_revision'])
                units = value['units']
                prepare = [unit for unit in units if unit['kind'] == 'prepare']
                self.assertEqual([u['kind'] for u in units], ['acquire'] + ['prepare'] * len(prepare) + ['quality'])
                self.assertLessEqual(len(prepare), MAX_PREPARE_UNITS)
                verses = [verse for unit in prepare for verse in unit['native_extent']['unit_ids']]
                self.assertTrue(all(len(unit['native_extent']['unit_ids']) <= MAX_VERSES for unit in prepare))
                self.assertEqual(verses, units[-1]['native_extent']['unit_ids'])
                self.assertEqual(len(set(verses)), len(verses))
                self.assertTrue(all(verse.startswith(book.book + '.') for verse in verses))
                self.assertEqual(units[-1]['depends_on'], [unit['unit_id'] for unit in prepare])
                self.assertEqual(units[-1]['required_capabilities'], value['capabilities'])

    def test_recipe_must_match_its_component(self):
        value, _, _ = fixture.recipe('tahot')
        for change in ({'native_extent': {'book': 'Mat', 'coordinate_version': value['native_extent']['coordinate_version']}},
                       {'native_extent': {'book': 'Exo', 'coordinate_version': 'other'}},
                       {'dependencies': []}, {'parameters': {**value['parameters'], 'commit': 'main'}},
                       {'parameters': {**value['parameters'], 'script': 'x'}},
                       {'adapter': {'name': DECLARATION.name, 'method_version': 'stepbible-tagged/0'}}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                BookRecipe.from_recipe({**value, **change})

    def test_original_stays_in_protected_storage(self):
        component, _ = fixture.component('tahot')
        self.assertTrue(component.original_key.startswith(f'originals/{component.revision_id}/{component.sha256}/'))
        row = component.admission_row()
        self.assertEqual(row['public_redistribution'], 'not_allowed')
        self.assertNotIn('git_history', row['permitted_uses_json'])


class RunnerFlowTest(unittest.TestCase):
    """Acquire, prepare two units and quality-check a synthetic book through `run_job`."""

    def setUp(self):
        self.api = LoopbackApi().__enter__()
        self.addCleanup(self.api.__exit__, None, None, None)
        self.recipe_value, self.component, self.raw = fixture.recipe('tahot', groups=[['Exo.1.1'], ['Exo.1.3']])
        book = BookRecipe.from_recipe(self.recipe_value)
        self.recipe = Recipe(book.acquire, book.prepare, book.read_source, book.declares)
        self.storage = CloudflareStorage(CloudflareConfig('acct', 'db', 'bucket', 'synthetic-token', TOKEN_ID,
                                                          api=Origin(self.api.origin), r2_origin=Origin(self.api.origin)))
        self.client = ControlClient(ControlConfig(Origin(self.api.origin), 'synthetic-id', 'synthetic-secret'),
                                    sleep=lambda _: None)
        self.api.control_handler = self.control
        self.inputs = [{'kind': 'acquisition', 'id': self.component.acquisition_id},
                       {'kind': 'source_revision', 'id': self.component.revision_id}]

    def control(self, method, path, headers, body):
        if path == '/internal/jobs/state':
            job = json.loads(self.current)
            digest = hashlib.sha256(self.current.encode('utf-8')).hexdigest()
            return 200, {'task_id': job['task_id'], 'task_revision': job['task_revision'], 'task_state': 'running',
                         'task_basis_digest': job['basis_digest'], 'unit_id': job['unit_id'], 'attempt': job['attempt'],
                         'job_revision': job['task_revision'], 'job_input_basis': digest, 'run_id': RUN_ID,
                         'job_state': 'dispatched'}
        return 200, {'status': 'accepted', 'eligible': True, 'state': 'succeeded'}

    def job_run(self, unit_id, **changes):
        unit = next(item for item in self.recipe_value['units'] if item['unit_id'] == unit_id)
        job = deepcopy(WIRE['job_input'])
        job.update(task_id='task-stepbible', unit_id=unit_id, kind=unit['kind'], native_extent=unit['native_extent'],
                   recipe_revision=self.recipe_value['revision'], input_refs=self.inputs, dependency_refs=[],
                   required_capabilities=unit.get('required_capabilities', []), checkpoint_ref=None, constraints={})
        job.update(changes)
        self.current = json.dumps(job, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        with mock.patch.dict(RECIPES, {self.recipe_value['revision']: self.recipe}):
            return runner.run_job(self.current, unit['kind'], run_id=RUN_ID, control=self.client, storage=self.storage)

    def test_acquire_prepare_and_quality_with_task_scoped_reads(self):
        def download(route, destination):
            self.assertEqual((route.url, route.expected_sha256), (self.component.url, self.component.sha256))
            destination.write_bytes(self.raw)
            return mock.Mock(complete=True, path=destination)
        with mock.patch('css_preparation.adapters.stepbible.transfer', side_effect=download) as fetched:
            result = self.job_run('acquire')
        self.assertEqual(result['state'], 'succeeded', result['diagnostics'])
        self.assertEqual(fetched.call_count, 1)
        self.assertEqual(self.api.objects[self.component.original_key], self.raw)
        self.assertEqual(self.storage.read_row('source_node', self.component.revision_id)['kind'], 'source_revision')
        # A second task acquiring the same component reuses the retained original and identical rows.
        with mock.patch('css_preparation.adapters.stepbible.transfer') as fetched:
            self.assertEqual(self.job_run('acquire', task_id='task-other')['state'], 'succeeded')
        fetched.assert_not_called()

        outputs = []
        for unit in ('prepare-01', 'prepare-02'):
            result = self.job_run(unit)
            self.assertEqual(result['state'], 'succeeded', result['diagnostics'])
            self.assertEqual(contract_errors('job_result', result), [])
            ids = {self.storage.read_row('artifact', ref['artifact_id'])['output_id'] for ref in result['output_refs']}
            outputs.extend(sorted(ids))
        self.api.queries.clear()
        result = self.job_run('quality', constraints={'candidate': {'added': outputs}})
        self.assertEqual(result['state'], 'succeeded', result['diagnostics'])
        self.assertEqual(len(result['coverage_refs']), 10)
        reads = [sql for sql in self.api.queries if sql.lstrip().startswith('SELECT * FROM (')]
        self.assertTrue(reads)
        self.assertTrue(all(' WHERE ' in sql for sql in reads))

    def test_gate_vouches_only_for_declared_unsaved_inputs(self):
        # Before acquisition, only the acquire unit may name the unsaved source revision.
        self.assertEqual(self.job_run('prepare-01')['state'], 'cancelled')
        changed = [{'kind': 'acquisition', 'id': self.component.acquisition_id, 'sha256': '0' * 64},
                   self.inputs[1]]
        self.assertEqual(self.job_run('acquire', input_refs=changed)['state'], 'cancelled')
        other = [{'kind': 'acquisition', 'id': 'stepbible-data:aaaaaaaaaaaa:tahot-isa-mal'}, self.inputs[1]]
        self.assertEqual(self.job_run('acquire', input_refs=other)['state'], 'cancelled')
        self.assertEqual(self.api.batches, [])

    def test_task_without_both_inputs_is_refused(self):
        with mock.patch('css_preparation.adapters.stepbible.transfer') as fetched:
            result = self.job_run('acquire', input_refs=self.inputs[:1])
        self.assertEqual(result['state'], 'failed')
        fetched.assert_not_called()


if __name__ == '__main__':
    unittest.main()
