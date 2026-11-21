"""Read the latest verified Terraform state and produce private Wrangler inputs."""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

class InstanceError(Exception):
    pass

def instance(bindings,client):
    if not isinstance(bindings,dict) or not re.fullmatch(r"[a-f0-9]{32}\.access",client or ""):
        raise InstanceError("Missing deployment identity")
    try:
        audiences=bindings["audiences"]
        hosts=bindings["hostnames"]
        result={
            "ACCOUNT_ID":bindings["account_id"],"ZONE_ID":bindings["zone_id"],
            "ZONE_NAME":bindings["zone_name"],"INSTANCE":bindings["instance"],
            "STUDY_HOSTNAME":hosts["study"],"CONTROL_HOSTNAME":hosts["control"],
            "DATABASE_ID":bindings["database_id"],"ACCESS_ISSUER":bindings["access_issuer"],
            "STUDY_AUDIENCE":audiences["study"],"CONTROL_AUDIENCE":audiences["control"],
            "JOB_AUDIENCE":audiences["jobs"],"DEPLOYMENT_CLIENT_ID":client,
            "ENHANCEMENTS":False,"AID_KV_CACHE_ENABLED":bindings.get("aid_kv_cache_enabled",True),
            "MAX_PAGE_BYTES":65536,"REQUEST_BYTES":262144,
            "MAX_D1_CALLS":25,"MAX_SUBREQUESTS":40,"CPU_BUDGET_MS":10
        }
        # A previously reviewed Worker commit must remain deployable for rollback.
        # Only new Study templates require the optional KV binding in rendered inputs.
        study_template = Path("services/study/wrangler.jsonc")
        if study_template.exists() and "{{VERIFIED_WORD_CACHE_NAMESPACE_ID}}" in study_template.read_text():
            result["VERIFIED_WORD_CACHE_NAMESPACE_ID"] = bindings["verified_word_cache_namespace_id"]
        if type(result["AID_KV_CACHE_ENABLED"]) is not bool:
            raise InstanceError("Invalid aid KV plan setting")
        if bindings["database_name"]!="css-data-"+result["INSTANCE"] or bindings["bucket_name"]!="css-private-"+result["INSTANCE"]:
            raise InstanceError("State resource naming mismatch")
        return result
    except (TypeError,KeyError):
        raise InstanceError("Incomplete Cloudflare state") from None

def main(output,state_path):
    trusted=Path(__file__).resolve().parents[1]/"platform_state.py"
    spec=importlib.util.spec_from_file_location("platform_state",trusted)
    transport=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transport)
    meta=transport.request("GET","/repos/"+transport.REPOSITORY)
    if not isinstance(meta,dict) or meta.get("private") is not True or meta.get("visibility")!="private":
        raise InstanceError("Private state repository not verified")
    try:
        transport.restore("cloudflare",state_path,allow_empty=False)
        state=json.loads(Path(state_path).read_text())
        values=state["outputs"]["bindings"]["value"]
        payload=instance(values,os.environ.get("DEPLOYMENT_ACCESS_CLIENT_ID",""))
        Path(output).write_text(json.dumps(payload),encoding="utf8")
        Path(output).chmod(0o600)
    finally:
        Path(state_path).unlink(missing_ok=True)

if __name__=="__main__":
    try:
        main(sys.argv[1],sys.argv[2])
    except Exception:
        print("Verified Cloudflare instance unavailable",file=sys.stderr)
        sys.exit(1)
