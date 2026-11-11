"""R2 S3-compatible API signing (AWS Signature Version 4) against AWS's published test vector."""
from datetime import datetime, timezone
import hashlib
import unittest

from css_preparation.runner.r2 import R2Objects, sign_v4


class SignatureV4Test(unittest.TestCase):
    def test_aws_published_get_vanilla_vector(self):
        # aws-sig-v4-test-suite "get-vanilla": GET / on example.amazonaws.com, 2015-08-30T12:36:00Z.
        headers = sign_v4('GET', 'example.amazonaws.com', '/', {}, hashlib.sha256(b'').hexdigest(),
                          access_key='AKIDEXAMPLE', secret_key='wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
                          region='us-east-1', service='service', now=datetime(2015, 8, 30, 12, 36, tzinfo=timezone.utc))
        self.assertEqual(headers['x-amz-date'], '20150830T123600Z')
        self.assertEqual(headers['Authorization'],
                         'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
                         'SignedHeaders=host;x-amz-date, '
                         'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')

    def test_derived_credentials_and_endpoint(self):
        objects = R2Objects('acct', 'bucket', '0123456789abcdef0123456789abcdef', 'token')
        self.assertEqual(objects._origin.base, 'https://acct.r2.cloudflarestorage.com')
        with self.assertRaises(ValueError):
            R2Objects('acct', 'bucket', 'AKIA-not-a-token-id', 'token')


if __name__ == '__main__':
    unittest.main()
