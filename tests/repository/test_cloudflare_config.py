"""Offline checks for protected input resolution and verified-state rendering."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,ROOT/path)
    m=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

inputs=module("cloudflare_inputs","infrastructure/github/cloudflare_inputs.py")
instance=module("deployment_instance","infrastructure/github/deployment/instance.py")

class CloudflareConfigTests(unittest.TestCase):
    def test_provider_resolved_ids_not_hand_maintained_json(self):
        fields={
            "PLATFORM_CF_ACCOUNT_ID":"a"*32,"PLATFORM_CF_ZONE_NAME":"example.invalid",
            "PLATFORM_CF_OWNER_EMAIL":"control@example.invalid",
            "PLATFORM_CF_STUDY_OWNER_EMAIL":"study@example.invalid",
            "PLATFORM_CF_ACCESS_ISSUER":"https://team.cloudflareaccess.com",
            "PLATFORM_CF_OAUTH_REDIRECT_URIS":"https://host.example.invalid/callback"
        }
        zones=[{"id":"b"*32,"name":"example.invalid","account":{"id":"a"*32}}]
        tokens=[{"name":"CSS Internal Jobs","id":"11111111-1111-4111-8111-111111111111"},
                {"name":"CSS Deployment Check","id":"22222222-2222-4222-8222-222222222222"}]
        with patch.dict(os.environ,fields):
            cfg=inputs.build(zones,tokens)
            self.assertEqual(cfg["hostnames"]["study"],"study.example.invalid")
            self.assertEqual(cfg["owner_email"],"control@example.invalid")
            self.assertEqual(cfg["study_owner_email"],"study@example.invalid")
            self.assertEqual(cfg["deployment_service_token_id"],tokens[1]["id"])
            with patch.dict(os.environ, {"PLATFORM_CF_STUDY_OWNER_EMAIL":""}):
                with self.assertRaises(inputs.InputError):
                    inputs.build(zones,tokens)
            with self.assertRaises(inputs.InputError):
                inputs.build(zones,tokens+tokens[:1])
            with self.assertRaises(inputs.InputError):
                inputs.build([{"id":"c"*32,"name":"other.invalid","account":{"id":"a"*32}}],tokens)

    def test_verified_binding_map_renders_without_resource_id_copying(self):
        binding={
            "account_id":"a"*32,"zone_id":"b"*32,"zone_name":"example.invalid",
            "instance":"main","hostnames":{"study":"study.example.invalid","control":"control.example.invalid"},
            "access_issuer":"https://team.cloudflareaccess.com",
            "database_id":"22222222-2222-4222-8222-222222222222","database_name":"css-data-main",
            "bucket_name":"css-private-main","audiences":{"study":"c"*64,"control":"d"*64,"jobs":"e"*64}
        }
        result=instance.instance(binding,"f"*32+".access")
        self.assertEqual(result["DATABASE_ID"],binding["database_id"])
        self.assertEqual(result["DEPLOYMENT_CLIENT_ID"],"f"*32+".access")
        with self.assertRaises(instance.InstanceError):
            instance.instance(binding,"not-a-client-id")
        with self.assertRaises(instance.InstanceError):
            instance.instance({**binding,"bucket_name":"wrong"},"f"*32+".access")
        with self.assertRaises(instance.InstanceError):
            instance.instance({**binding,"audiences":{}},"f"*32+".access")


class InventoryPaginationTests(unittest.TestCase):
    def test_list_requires_complete_inventory_before_matching_principals(self):
        import io
        from unittest.mock import patch

        def get(records, info=None, limit=100):
            payload = {"success": True, "result": records}
            if info is not None:
                payload["result_info"] = info
            data = io.BytesIO(__import__("json").dumps(payload).encode())
            class Response:
                def __enter__(self): return data
                def __exit__(self, *_): return False
            class Opener:
                def open(self, *_args, **_kwargs): return Response()
            with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "fixture"}), patch.object(inputs.urllib.request, "build_opener", return_value=Opener()):
                return inputs.api("accounts/a/access/service_tokens", {"per_page": limit})

        info = {"page": 1, "total_pages": 1, "total_count": 1}
        self.assertEqual(get([{"name": "fixture"}], info), [{"name": "fixture"}])
        with self.assertRaises(inputs.InputError):
            get([{"name": "fixture"}], None)
        for incomplete in [
            {"page": 1, "total_pages": 2, "total_count": 101},
            {"page": 2, "total_pages": 2, "total_count": 101},
            {"page": 1, "total_pages": 1, "total_count": 2},
            {"page": 1, "total_pages": 1},
        ]:
            with self.assertRaises(inputs.InputError):
                get([{"name": "fixture"}], incomplete)
        with self.assertRaises(inputs.InputError):
            get([{"name": "fixture"}], None, limit=1)

if __name__=="__main__":
    unittest.main()
