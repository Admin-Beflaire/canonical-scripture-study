"""The executor validates the same job envelopes as Control."""
import json
from pathlib import Path
import unittest

from css_preparation.contracts import ContractError, contract_errors, job_result, parse_job_input

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / 'conformance/maintenance-jobs.v1.json').read_text())


class MaintenanceContractsTest(unittest.TestCase):
    def test_shared_fixtures(self):
        for name in ('job_input', 'job_result'):
            for value in FIXTURE['valid'][name]:
                self.assertEqual(contract_errors(name, value), [])
            for value in FIXTURE['invalid'][name]:
                self.assertTrue(contract_errors(name, value), json.dumps(value))

    def test_parse_input_and_build_matching_result(self):
        job = parse_job_input(json.dumps(FIXTURE['valid']['job_input'][0]))
        result = job_result(job, run_id='run-9', completed_extent={}, remaining_extent=job['native_extent'],
                            output_refs=[], coverage_refs=[], checkpoint_ref=None, quality_receipt_ref=None,
                            state='checkpointed', diagnostics=[])
        self.assertEqual((result['task_id'], result['attempt'], result['basis_digest']),
                         (job['task_id'], job['attempt'], job['basis_digest']))
        with self.assertRaises(ContractError):
            parse_job_input(json.dumps(FIXTURE['invalid']['job_input'][0]))
        with self.assertRaises(ContractError):
            job_result(job, run_id='run-9', state='promoted')


if __name__ == '__main__':
    unittest.main()
