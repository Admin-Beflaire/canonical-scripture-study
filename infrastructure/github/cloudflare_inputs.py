"""Generate private Terraform inputs from protected one-time settings and Cloudflare inventory.

No account-specific file is committed; resource and service-token IDs are
resolved on each authorized plan/apply. Provider responses are never logged.
"""
import json
import os
from pathlib import Path
import re
import sys
import urllib.request
from urllib.parse import urlencode

class InputError(Exception):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise InputError("Provider redirect not allowed")

def env(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise InputError("Missing protected setting")
    return value

def api(path, params=None):
    url="https://api.cloudflare.com/client/v4/"+path
    if params:
        url+="?"+urlencode(params)
    req=urllib.request.Request(url,headers={
        "Authorization":"Bearer "+env("CLOUDFLARE_API_TOKEN"),
        "Accept":"application/json","User-Agent":"css-terraform-inputs"
    })
    try:
        with urllib.request.build_opener(NoRedirect()).open(req,timeout=30) as response:
            data=json.load(response)
        if data.get("success") is not True or not isinstance(data.get("result"),list):
            raise InputError("Invalid Cloudflare inventory")
        return data["result"]
    except (OSError,ValueError,KeyError):
        raise InputError("Cloudflare inventory unavailable") from None

def build(zones,tokens):
    account=env("PLATFORM_CF_ACCOUNT_ID")
    zone=env("PLATFORM_CF_ZONE_NAME")
    if not re.fullmatch("[a-f0-9]{32}",account) or not re.fullmatch(r"(?:[a-z0-9-]+\.)+[a-z]{2,63}",zone):
        raise InputError("Invalid account or zone")
    matched=[z for z in zones if z.get("name")==zone and z.get("account",{}).get("id")==account]
    if len(matched)!=1 or not re.fullmatch("[a-f0-9]{32}",matched[0].get("id","")):
        raise InputError("Zone identity not unique")
    ids={}
    for kind,name in (("job","CSS Internal Jobs"),("deployment","CSS Deployment Check")):
        found=[t for t in tokens if t.get("name")==name]
        if len(found)!=1 or not re.fullmatch(r"[a-f0-9-]{36}",found[0].get("id","")):
            raise InputError("Access service-token identity not unique")
        ids[kind]=found[0]["id"]
    issuer=env("PLATFORM_CF_ACCESS_ISSUER")
    owner=env("PLATFORM_CF_OWNER_EMAIL")
    if not re.fullmatch(r"https://[a-z0-9-]+\.cloudflareaccess\.com",issuer) or not re.fullmatch(r"[^@ ]+@[^@ ]+\.[^@ ]+",owner):
        raise InputError("Invalid Access identity")
    callbacks=[s.strip() for s in env("PLATFORM_CF_OAUTH_REDIRECT_URIS").split(";") if s.strip()]
    if not callbacks or any(not re.fullmatch(r"https://[^/ *]+/[^ ]*",s) for s in callbacks):
        raise InputError("Verified HTTPS callback URIs required")
    instance=os.environ.get("PLATFORM_CF_INSTANCE","").strip() or "main"
    if not re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,23}[a-z0-9])?",instance):
        raise InputError("Invalid instance")
    return {
        "account_id":account,"zone_id":matched[0]["id"],"zone_name":zone,
        "access_issuer":issuer,"instance":instance,"owner_email":owner,
        "hostnames":{"study":"study."+zone,"control":"control."+zone},
        "oauth_redirect_uris":callbacks,
        "job_service_token_id":ids["job"],"deployment_service_token_id":ids["deployment"]
    }

def main(path):
    account=env("PLATFORM_CF_ACCOUNT_ID")
    zones=api("zones",{"name":env("PLATFORM_CF_ZONE_NAME"),"per_page":50})
    tokens=api("accounts/"+account+"/access/service_tokens",{"per_page":100})
    target=Path(path)
    target.write_text(json.dumps(build(zones,tokens)),encoding="utf8")
    target.chmod(0o600)

if __name__=="__main__":
    try:
        main(sys.argv[1])
    except (InputError,IndexError,KeyError,TypeError,ValueError,OSError):
        print("Protected Cloudflare configuration unavailable",file=sys.stderr)
        sys.exit(1)
