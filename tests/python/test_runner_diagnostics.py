"""Preparation diagnostics contain useful errors, but not arbitrary private data."""
import json
from pathlib import Path
import tempfile
import unittest

from css_preparation.prepare.records import RecordError
from css_preparation.provider import ProviderError
from css_preparation.runner.diagnostics import DiagnosticRecorder


class DiagnosticRecorderTests(unittest.TestCase):
    def records(self, emit):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'diagnostics.jsonl'
            recorder = DiagnosticRecorder(str(path), run_id='44698355209', kind='acquire')
            emit(recorder)
            return [json.loads(line) for line in path.read_text().splitlines()]

    def test_full_trusted_acquisition_error_is_readable(self):
        def emit(recorder):
            try:
                raise RecordError('Acquisition failed: bing-nt-outlines-2024/1: server answered 403')
            except RecordError as error:
                recorder.exception('acquiring_input', error)
            recorder.outcome('failed')
        error, outcome = self.records(emit)
        self.assertEqual(error['stage'], 'acquiring_input')
        self.assertEqual(error['exception'], 'RecordError')
        self.assertEqual(error['detail'],
                         'Acquisition failed: bing-nt-outlines-2024/1: server answered 403')
        self.assertEqual(outcome['state'], 'failed')
        self.assertEqual(error['run_id'], '44698355209')

    def test_untrusted_messages_are_never_copied(self):
        def emit(recorder):
            for error in (RecordError('Bearer synthetic-secret and private source data'),
                          ProviderError('Bearer synthetic-secret and private response', status=429),
                          OSError('synthetic-secret file contents')):
                try:
                    raise error
                except Exception as failure:
                    recorder.exception('acquiring_input', failure)
        rows = self.records(emit)
        text = json.dumps(rows)
        self.assertNotIn('synthetic-secret', text)
        self.assertNotIn('private source', text)
        self.assertNotIn('private response', text)
        self.assertEqual(rows[1]['http_status'], 429)
        self.assertEqual(rows[1]['detail'],
                         'Provider request failed during acquiring_input with HTTP 429')
        self.assertTrue(all(isinstance(row['frames'], list) for row in rows))

    def test_untrusted_acquisition_lookalike_does_not_pass(self):
        def emit(recorder):
            try:
                raise RecordError('Acquisition failed: bing/1: server answered 403 and token=secret')
            except RecordError as error:
                recorder.exception('acquiring_input', error)
        [row] = self.records(emit)
        self.assertNotIn('detail', row)


if __name__ == '__main__':
    unittest.main()
