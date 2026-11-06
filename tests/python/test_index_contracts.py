"""Local fixture consumers only: not a production builder, remote reader or promotion path."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import Mock

import test_evidence_contracts as evidence
from css_shared import extract_scalar_segments

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = ROOT / 'tests/conformance/indexes'
FIXTURE = json.loads((FIXTURE_ROOT / 'fixture.json').read_text())
MANIFESTS = {name: json.loads((FIXTURE_ROOT / path).read_text()) for name,path in FIXTURE['manifests'].items()}


def order(row):
    return row['search_key'].encode('utf-8'), row['native_order'], row['occurrence_id'].encode('utf-8')


def page_directory(manifest, key):
    return [(file,page) for file in manifest['files'] for page in file['pages']
            if page['first_key'].encode() <= key.encode() <= page['last_key'].encode()]


def read_fixture_window(manifest, key, position, budget, fetch, hasher=hashlib.sha256, decode=json.loads):
    """Minimal contract probe, with bounds checked before fetch/hash/decode."""
    pages = page_directory(manifest,key)
    if position < 0 or position > len(pages) or budget['max_pages'] < 1:
        raise ValueError('Invalid fixture continuation/budget')
    window = pages[position:position+budget['max_pages']]
    if (any(p['byte_length'] > min(manifest['encoded_page_cap_bytes'],budget['max_encoded_page_bytes'])
            or p['byte_offset'] < 0 or p['byte_length'] <= 0
            or p['byte_offset']+p['byte_length'] > f['byte_length'] for f,p in window)
            or sum(p['byte_length'] for _,p in window) > budget['max_request_bytes']):
        raise ValueError('Encoded page bounds exceeded')
    result = []
    for file,page in window:
        raw = fetch(file['artifact_id'],page['byte_offset'],page['byte_length'])
        if len(raw) != page['byte_length'] or hasher(raw).hexdigest() != page['sha256']:
            raise ValueError('Page integrity mismatch')
        if not raw.endswith(b'\n'):
            raise ValueError('Unaligned NDJSON page')
        rows = [decode(line) for line in raw.decode('utf-8',errors='strict').splitlines()]
        result.extend(row for row in rows if row['search_key'] == key)
    next_position = position+len(window)
    return result,next_position,next_position == len(pages)


def compatible(manifest, expected, coverage, selected_outputs):
    fields = ('format_version','index_kind','prepared_output_id','source_revision_ids','native_extent',
              'coordinate_version','normalization_rule','tokenizer_version','analysis_revision_ids')
    return (all(manifest.get(k) == expected[k] for k in fields)
            and manifest['prepared_output_id'] in selected_outputs
            and manifest['coverage']['state'] == coverage['state'] == 'available'
            and manifest['native_extent'] == coverage['native_extent_json']
            and manifest['prepared_output_id'] == coverage['output_id']
            and manifest['coverage']['capabilities'] == expected['coverage']['capabilities'])


class IndexContractTests(unittest.TestCase):
    def fetch(self, artifact, offset, length):
        with (FIXTURE_ROOT / FIXTURE['postings'][artifact]).open('rb') as stream:
            stream.seek(offset)
            return stream.read(length)

    def database(self):
        helper = evidence.EvidenceContractsTests()
        helper.setUp()
        self.addCleanup(helper.doCleanups)
        helper.db.executescript((ROOT / 'schemas/migrations/0002_span_navigation.sql').read_text())
        for kind,records in FIXTURE['evidence_delta'].items():
            for record in records: helper.insert(kind,record)
        for row in FIXTURE['span_segments']:
            helper.db.execute('INSERT INTO span_segments VALUES(?,?,?,?,?,?)', tuple(row.values()))
        helper.db.commit()
        return helper

    def test_pages_are_contiguous_line_aligned_sorted_and_registered(self):
        for name,m in MANIFESTS.items():
            seen=set();previous=None
            for file in m['files']:
                raw=(FIXTURE_ROOT/FIXTURE['postings'][file['artifact_id']]).read_bytes()
                self.assertEqual(len(raw),file['byte_length'])
                self.assertEqual(hashlib.sha256(raw).hexdigest(),file['sha256'])
                offset=0
                for page in file['pages']:
                    self.assertEqual(page['byte_offset'],offset)
                    part=raw[offset:offset+page['byte_length']]
                    self.assertLessEqual(len(part),m['encoded_page_cap_bytes'])
                    self.assertEqual(hashlib.sha256(part).hexdigest(),page['sha256'])
                    self.assertTrue(part.endswith(b'\n'))
                    records=[json.loads(line) for line in part.decode('utf-8',errors='strict').splitlines()]
                    self.assertEqual(records[0]['search_key'],page['first_key'])
                    self.assertEqual(records[-1]['search_key'],page['last_key'])
                    for row in records:
                        self.assertNotIn((row['search_key'],row['occurrence_id']),seen)
                        seen.add((row['search_key'],row['occurrence_id']))
                        if previous is not None:self.assertLess(previous,order(row))
                        previous=order(row)
                    offset+=page['byte_length']
                self.assertEqual(offset,len(raw))

    def test_common_key_spans_pages_without_duplicates_and_continues_within_budget(self):
        for name,key,expected in [('source','א',FIXTURE['expected_source_occurrences']),('word','form:א',FIXTURE['expected_word_occurrences'])]:
            m=MANIFESTS[name];position=0;all_rows=[];rounds=0;done=False
            self.assertGreater(len(page_directory(m,key)),1)
            while not done:
                rows,position,done=read_fixture_window(m,key,position,FIXTURE['fixture_budget'],self.fetch)
                all_rows.extend(rows);rounds+=1
                if name=='word' and rounds==1:self.assertFalse(done)
            self.assertEqual([r['occurrence_id'] for r in all_rows],expected)
            self.assertEqual(len({r['occurrence_id'] for r in all_rows}),len(expected))
            self.assertEqual(sorted(all_rows,key=order),all_rows)
        self.assertEqual(page_directory(MANIFESTS['source'],'ג'),[])
        empty,_,done=read_fixture_window(MANIFESTS['source'],'',0,FIXTURE['fixture_budget'],self.fetch)
        self.assertEqual([r['occurrence_id'] for r in empty],['occ-000']);self.assertTrue(done)

    def test_bounds_reject_before_any_read_hash_or_decode(self):
        for mutation in ('page_cap','request_cap','range'):
            m=deepcopy(MANIFESTS['source']);budget=deepcopy(FIXTURE['fixture_budget'])
            if mutation=='page_cap':budget['max_encoded_page_bytes']=1
            elif mutation=='request_cap':budget['max_request_bytes']=1
            else:m['files'][0]['pages'][0]['byte_length']=m['files'][0]['byte_length']+1
            read,hash_page,decode=Mock(),Mock(),Mock()
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):
                read_fixture_window(m,'א',0,budget,read,hash_page,decode)
            for callback in (read,hash_page,decode):callback.assert_not_called()

    def test_corrupt_or_non_line_aligned_pages_reject(self):
        with self.assertRaisesRegex(ValueError,'integrity'):
            read_fixture_window(MANIFESTS['source'],'א',0,FIXTURE['fixture_budget'],lambda _,o,n:b'x'*n)
        m=deepcopy(MANIFESTS['source']);file=m['files'][0];page=file['pages'][0]
        raw=self.fetch(file['artifact_id'],page['byte_offset'],page['byte_length'])[:-1]
        page['byte_length']=len(raw);page['sha256']=hashlib.sha256(raw).hexdigest()
        with self.assertRaisesRegex(ValueError,'Unaligned'):
            read_fixture_window(m,'',0,FIXTURE['fixture_budget'],lambda *_:raw)

    def test_exact_wording_and_analysis_identity_survive_normalization(self):
        rows,_,_=read_fixture_window(MANIFESTS['source'],'א',0,FIXTURE['fixture_budget'],self.fetch)
        for row in rows:
            text=extract_scalar_segments(row['native_reference'],dict(source_revision_id=row['source_revision_id'],coordinate_version=row['coordinate_version'],units=FIXTURE['native_units']))
            self.assertEqual(text,['אָ']);self.assertNotEqual(text[0],row['search_key'])
        records=[json.loads(line) for line in (FIXTURE_ROOT/'word.ndjson').read_text().splitlines()]
        for row in records:
            analyses=row['analyses'];self.assertEqual(len({a['analysis_id'] for a in analyses}),2)
            self.assertEqual(len({a['lemma_id'] for a in analyses}),2)
            self.assertEqual({a['analysis_revision_id'] for a in analyses},set(MANIFESTS['word']['analysis_revision_ids']))

    def test_navigation_finds_overlapping_discontinuous_units_with_scoped_index(self):
        helper=self.database();db=helper.db
        sql='SELECT DISTINCT ss.span_id FROM span_segments ss JOIN native_spans ns ON ns.id=ss.span_id JOIN release_outputs ro ON ro.output_id=ns.output_id WHERE ro.release_id=? AND ss.source_revision_id=? AND ss.kind=? AND ss.start_order<=? AND ss.end_order>=? ORDER BY ss.span_id'
        args=('ix-release','synthetic:a:source_revision','literary_unit',8,8)
        self.assertEqual([r[0] for r in db.execute(sql,args)],['ix-literary','ix-overlap'])
        self.assertEqual([r[0] for r in db.execute(sql,args[:-2]+(5,5))],['ix-overlap'])
        plan=db.execute('EXPLAIN QUERY PLAN '+sql,args).fetchall()
        self.assertTrue(any('span_segments_source_kind_order' in row[3] for row in plan))
        segments=db.execute("SELECT segment_ordinal,start_order,end_order FROM span_segments WHERE span_id='ix-literary' ORDER BY segment_ordinal").fetchall()
        self.assertEqual([tuple(r) for r in segments],[(0,2,3),(1,8,9)])
        self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_navigation_identity_and_selected_output_guards(self):
        helper=self.database();db=helper.db;row=FIXTURE['span_segments'][0]
        with self.assertRaises(sqlite3.IntegrityError):db.execute('UPDATE span_segments SET start_order=0')
        with self.assertRaises(sqlite3.IntegrityError):db.execute('INSERT INTO span_segments VALUES(?,?,?,?,?,?)',(row['span_id'],99,row['source_revision_id'],row['kind'],0,1))
        db.execute("UPDATE release_selection SET current_release_id='ix-release'")
        with self.assertRaises(sqlite3.IntegrityError):db.execute('DELETE FROM span_segments')
        with self.assertRaises(sqlite3.IntegrityError):db.execute('INSERT INTO span_segments VALUES(?,?,?,?,?,?)',tuple(row.values()))

    def test_lemma_links_have_independent_ids_receipts_and_native_targets(self):
        db=self.database().db
        for provider in ('0','1'):
            rows=db.execute("SELECT r.id,r.basis_json,m.span_id FROM relationships r JOIN relation_members m ON m.relationship_id=r.id WHERE r.kind='lemma_lexicon_entry' AND json_extract(r.basis_json,'$.lemma_id')=? AND m.role='to'",('provider-'+provider+':lemma-א',)).fetchall()
            self.assertEqual(len(rows),1)
            self.assertEqual(rows[0]['span_id'],'ix-lex-'+provider)
            self.assertEqual(json.loads(rows[0]['basis_json'])['receipt_id'],'synthetic-link-receipt-'+provider)
        self.assertEqual(MANIFESTS['lexicon']['index_kind'],'source_text')

    def test_incompatible_or_incomplete_index_metadata_cannot_satisfy_current_contract(self):
        helper=self.database();db=helper.db
        selected={r[0] for r in db.execute("SELECT output_id FROM release_outputs WHERE release_id='ix-release'")}
        for name,expected in MANIFESTS.items():
            coverage=next(c for c in FIXTURE['evidence_delta']['coverage'] if c['output_id']==expected['prepared_output_id'])
            self.assertTrue(compatible(expected,expected,coverage,selected))
            for field,value in [('format_version','future/2'),('coordinate_version','wrong'),('normalization_rule','wrong'),('tokenizer_version','wrong'),('source_revision_ids',['wrong']),('analysis_revision_ids',[] if name=='word' else ['wrong']),('native_extent',{'unit_ids':['wrong']})]:
                broken=deepcopy(expected);broken[field]=value
                with self.subTest(name=name,field=field):self.assertFalse(compatible(broken,expected,coverage,selected))
            broken=deepcopy(expected);broken['coverage']['state']='partial';broken['coverage']['limitation']='fixture incomplete'
            self.assertFalse(compatible(broken,expected,coverage,selected))
            self.assertFalse(compatible(expected,expected,coverage,set()))
        self.assertIsNone(db.execute('SELECT current_release_id FROM release_selection').fetchone()[0])
