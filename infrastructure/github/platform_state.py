"""Private GitHub release-backed Terraform state protocol for trusted Actions.

Immutable, run-attempt-qualified begin/state/receipt assets. An unfinished or
failed attempt blocks all subsequent runs until a separately reviewed repair.
No state bytes or provider response bodies are printed to public logs.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

REPOSITORY = os.environ.get("PLATFORM_STATE_REPO", "")
TAG = "platform-state-v1"
ROOT = "https://api.github.com"
KEYS = {"github", "cloudflare"}
SAFE_ID = re.compile(r"^[0-9]{1,20}-[0-9]{1,5}$")


class StateError(Exception):
    pass


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Do not forward the private state token to signed asset destinations."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).scheme != "https":
            raise StateError("Private state redirect must use HTTPS")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected and urlsplit(req.full_url).netloc.lower() != urlsplit(newurl).netloc.lower():
            redirected.remove_header("Authorization")
        return redirected


def digest(data):
    return hashlib.sha256(data).hexdigest()


def request(method, path, data=None, binary=False, upload=False):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", REPOSITORY) or REPOSITORY == os.environ.get("GITHUB_REPOSITORY"):
        raise StateError("Invalid private state repository boundary")
    token = os.environ["PLATFORM_STATE_TOKEN"]
    host = "https://uploads.github.com" if upload else ROOT
    headers = {
        "Authorization": "Bearer " + token,
        "Accept": "application/octet-stream" if binary else "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "css-provisioning",
    }
    if data is not None:
        headers["Content-Type"] = "application/octet-stream" if upload else "application/json"
    req = urllib.request.Request(host + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.build_opener(SafeRedirectHandler()).open(req, timeout=30) as response:
            body = response.read()
            if binary:
                return body
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        # Provider response bodies may contain private values; never disclose them.
        raise StateError("Private state API request failed (HTTP " + str(exc.code) + ")") from None
    except (OSError, ValueError) as exc:
        raise StateError("Private state API request failed") from None


def release(create=False):
    path = "/repos/" + REPOSITORY + "/releases/tags/" + TAG
    obj = request("GET", path)
    if obj is None and create:
        payload = json.dumps({"tag_name": TAG, "name": "Operational Terraform state",
                              "draft": False, "prerelease": True}).encode()
        obj = request("POST", "/repos/" + REPOSITORY + "/releases", payload)
    return obj


def assets(rel):
    result = []
    page = 1
    while True:
        chunk = request("GET", "/repos/" + REPOSITORY + "/releases/" +
                        str(rel["id"]) + "/assets?per_page=100&page=" + str(page))
        if chunk is None:
            raise StateError("Protected release assets unavailable")
        result.extend(chunk)
        if len(chunk) < 100:
            return result
        page += 1


def names(key, run):
    return (key + "--" + run + "--begin.json",
            key + "--" + run + "--state.tfstate",
            key + "--" + run + "--receipt.json")


def upload(rel, name, data):
    # Never overwrite an asset. Concurrent runs are serialized by Actions;
    # the duplicate check also prevents stale or accidental replay.
    existing = {x["name"] for x in assets(rel)}
    if name in existing:
        raise StateError("Duplicate private state asset; reconcile before retry")
    path = "/repos/" + REPOSITORY + "/releases/" + str(rel["id"]) + "/assets?name=" + name
    result = request("POST", path, data, upload=True)
    if not isinstance(result, dict) or result.get("name") != name:
        raise StateError("State asset upload not confirmed")
    return result


def download(asset):
    data = request("GET", "/repos/" + REPOSITORY + "/releases/assets/" + str(asset["id"]), binary=True)
    if not isinstance(data, bytes):
        raise StateError("State asset unavailable")
    return data


def inventory(key, allow_missing=False):
    if key not in KEYS:
        raise StateError("Unknown state key")
    rel = release()
    if rel is None:
        if allow_missing:
            return None, None
        raise StateError("Protected state release absent; adopt or initialize explicitly")
    found = {asset["name"]: asset for asset in assets(rel)}
    prefix = key + "--"
    # Never silently reuse historical/unrecognized state in the same release.
    unknown = [name for name in found if name.startswith(prefix)
               and not re.fullmatch(re.escape(prefix) + r"[0-9]{1,20}-[0-9]{1,5}--(begin\.json|state\.tfstate|receipt\.json)", name)]
    if unknown:
        raise StateError("Unrecognized state assets require explicit migration")
    attempts = {}
    for name, asset in found.items():
        if not name.startswith(prefix):
            continue
        match = re.fullmatch(re.escape(prefix) + r"([0-9]{1,20}-[0-9]{1,5})--(begin\.json|state\.tfstate|receipt\.json)", name)
        if match:
            attempts.setdefault(match[1], {})[match[2]] = asset
    # Every begin MUST have a successful terminal receipt to start any new run.
    completed = []
    for run, parts in attempts.items():
        if "begin.json" not in parts or "receipt.json" not in parts or "state.tfstate" not in parts:
            raise StateError("Interrupted state attempt; reconcile before another run")
        receipt = json.loads(download(parts["receipt.json"]))
        if not isinstance(receipt, dict) or receipt.get("run") != run or receipt.get("key") != key:
            raise StateError("State receipt identity mismatch")
        if receipt.get("outcome") != "success":
            raise StateError("Failed/uncertain apply requires independent reconciliation")
        completed.append((int(run.split("-")[0]), int(run.split("-")[1]), parts, receipt))
    completed.sort()
    if len(completed) != len(attempts):
        raise StateError("Inconsistent state inventory")
    return rel, (completed[-1] if completed else None)


def restore(key, output, allow_empty=False):
    rel, latest = inventory(key, allow_missing=allow_empty)
    if latest is None:
        if not allow_empty or key != "cloudflare":
            raise StateError("Missing verified state; import/reconcile existing resources first")
        # Empty Cloudflare bootstrap is authorized only by an explicit dispatch input.
        return "empty"
    _, _, parts, receipt = latest
    data = download(parts["state.tfstate"])
    if digest(data) != receipt.get("sha256") or len(data) != receipt.get("bytes"):
        raise StateError("Protected state digest/size mismatch")
    path = Path(output)
    path.write_bytes(data)
    path.chmod(0o600)
    return "verified"


def begin(key, run):
    if key not in KEYS or not SAFE_ID.fullmatch(run):
        raise StateError("Invalid state identity")
    rel, latest = inventory(key, allow_missing=True)
    # An old workflow rerun must never overwrite the effective latest state.
    if latest is not None and tuple(map(int, run.split("-"))) <= latest[:2]:
        raise StateError("Stale run attempt; use a new workflow dispatch")
    if rel is None:
        rel = release(create=True)
    # Reserve room for begin, state and terminal receipt before mutation.
    if len(assets(rel)) > 997:
        raise StateError("State release capacity exhausted; migrate before apply")
    upload(rel, names(key, run)[0], json.dumps({"key": key, "run": run,
                                                "stage": "begin"}, sort_keys=True).encode())


def finish(key, run, state_path, success):
    if key not in KEYS or not SAFE_ID.fullmatch(run):
        raise StateError("Invalid state identity")
    rel = release()
    if rel is None:
        raise StateError("Protected state release absent")
    found = {x["name"]: x for x in assets(rel)}
    start, state_name, done = names(key, run)
    if start not in found or done in found or state_name in found:
        raise StateError("Invalid state-finalization attempt")
    data = Path(state_path).read_bytes()
    if not data:
        raise StateError("No state to preserve; manual reconciliation required")
    saved = upload(rel, state_name, data)
    if digest(download(saved)) != digest(data):
        raise StateError("State upload integrity failed; reconciliation required")
    record = {"key": key, "run": run, "sha256": digest(data),
              "bytes": len(data), "outcome": "success" if success else "uncertain"}
    upload(rel, done, json.dumps(record, sort_keys=True).encode())
    if not success:
        raise StateError("Apply failed: state saved but reconciliation is required")



def baseline_digest(key, allow_empty=False):
    """Fingerprint the same verified state a plan must be based on."""
    rel, latest = inventory(key, allow_missing=allow_empty)
    if latest is None:
        if allow_empty and key == "cloudflare":
            return "empty"
        raise StateError("No verified state for planning")
    _, _, parts, receipt = latest
    data = download(parts["state.tfstate"])
    if digest(data) != receipt.get("sha256") or len(data) != receipt.get("bytes"):
        raise StateError("Plan baseline failed verification")
    return digest(data)


def plan_names(key, run):
    if key not in KEYS or not SAFE_ID.fullmatch(run):
        raise StateError("Invalid plan identity")
    prefix = "plan--" + key + "--" + run + "--"
    return prefix + "binary.tfplan", prefix + "review.txt", prefix + "manifest.json"


def plan_save(key, run, commit, plan_file, review_file, allow_empty=False):
    """Store an exact saved plan and review text in the existing private release."""
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise StateError("Invalid reviewed commit")
    base = baseline_digest(key, allow_empty)
    saved_plan = Path(plan_file).read_bytes()
    readable = Path(review_file).read_bytes()
    if not saved_plan or not readable:
        raise StateError("Empty private plan")
    rel = release(create=True)
    if len(assets(rel)) > 997:
        raise StateError("Private release has insufficient room for plan")
    plan_name, review_name, manifest_name = plan_names(key, run)
    existing = {a["name"] for a in assets(rel)}
    if any(name in existing for name in (plan_name, review_name, manifest_name)):
        raise StateError("Plan already exists; use a fresh dispatch")
    stored_plan = upload(rel, plan_name, saved_plan)
    stored_review = upload(rel, review_name, readable)
    if digest(download(stored_plan)) != digest(saved_plan) or digest(download(stored_review)) != digest(readable):
        raise StateError("Private plan integrity check failed")
    manifest = {
        "key": key, "run": run, "commit": commit,
        "baseline": base, "sha256": digest(saved_plan),
        "bytes": len(saved_plan), "review_sha256": digest(readable),
    }
    upload(rel, manifest_name, json.dumps(manifest, sort_keys=True).encode())


def plan_fetch(key, run, commit, approved_digest, output, allow_empty=False):
    """Require owner-supplied plan digest and the original verified state."""
    if not re.fullmatch(r"[0-9a-f]{40}", commit) or not re.fullmatch(r"[0-9a-f]{64}", approved_digest):
        raise StateError("Invalid approved plan identity")
    rel = release()
    if rel is None:
        raise StateError("Missing private plan release")
    found = {a["name"]: a for a in assets(rel)}
    plan_name, review_name, manifest_name = plan_names(key, run)
    if not all(name in found for name in (plan_name, review_name, manifest_name)):
        raise StateError("Incomplete private plan; rerun planning")
    record = json.loads(download(found[manifest_name]))
    if (not isinstance(record, dict) or record.get("key") != key or record.get("run") != run
            or record.get("commit") != commit or record.get("sha256") != approved_digest):
        raise StateError("Plan approval does not match stored plan")
    if record.get("baseline") != baseline_digest(key, allow_empty):
        raise StateError("State baseline changed since plan; create a new plan")
    binary = download(found[plan_name])
    readable = download(found[review_name])
    if (digest(binary) != approved_digest or len(binary) != record.get("bytes")
            or digest(readable) != record.get("review_sha256")):
        raise StateError("Private plan integrity check failed")
    path = Path(output)
    path.write_bytes(binary)
    path.chmod(0o600)


def rescue(key, run, state_path):
    """Private Contents API fallback if ordinary release finalization failed.

    A rescue copy is not an accepted state: the interrupted begin stays blocked
    until the operator reconciles and repairs it. Never overwrite recovery data.
    """
    if key not in KEYS or not SAFE_ID.fullmatch(run):
        raise StateError("Invalid recovery identity")
    data = Path(state_path).read_bytes()
    if not data:
        raise StateError("No state available for private recovery")
    path = "/repos/" + REPOSITORY + "/contents/platform-recovery/" + key + "/" + run + ".tfstate"
    if request("GET", path) is not None:
        raise StateError("Private recovery snapshot already exists; inspect it")
    payload = json.dumps({
        "message": "recovery: hold Terraform state for independent reconciliation",
        "content": base64.b64encode(data).decode("ascii"),
    }).encode()
    saved = request("PUT", path, payload)
    if not isinstance(saved, dict) or not saved.get("content", {}).get("sha"):
        raise StateError("Private recovery snapshot not confirmed")
    # Contents API does not return base64 content for blobs over 1 MB.
    # Read by the committed Git blob SHA instead, including large states.
    blob_sha = saved["content"]["sha"]
    check = request("GET", "/repos/" + REPOSITORY + "/git/blobs/" + blob_sha)
    try:
        if not isinstance(check, dict) or check.get("encoding") != "base64":
            raise StateError("Private recovery readback format invalid")
        verified = base64.b64decode(check["content"], validate=True)
    except (TypeError, ValueError, KeyError, AttributeError):
        raise StateError("Private recovery readback failed") from None
    if digest(verified) != digest(data):
        raise StateError("Private recovery digest mismatch")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=("restore", "begin", "finish", "plan-save", "plan-fetch", "rescue"))
    p.add_argument("--key", required=True, choices=sorted(KEYS))
    p.add_argument("--run")
    p.add_argument("--path")
    p.add_argument("--allow-empty", action="store_true")
    p.add_argument("--commit")
    p.add_argument("--plan-run")
    p.add_argument("--plan-sha256")
    p.add_argument("--review-path")
    p.add_argument("--success", action="store_true")
    a = p.parse_args()
    metadata = request("GET", "/repos/" + REPOSITORY)
    if (not isinstance(metadata, dict) or metadata.get("private") is not True
            or metadata.get("visibility") != "private"):
        raise StateError("Protected state destination is not verified private")
    if a.command in ("begin", "finish") and (not a.run or not SAFE_ID.fullmatch(a.run)):
        raise StateError("Run must be the fixed GitHub run-id/attempt")
    if a.command in ("restore", "finish", "plan-save", "plan-fetch", "rescue") and not a.path:
        raise StateError("Missing state path")
    if a.command == "restore":
        restore(a.key, a.path, a.allow_empty)
    elif a.command == "begin":
        begin(a.key, a.run)
    elif a.command == "finish":
        finish(a.key, a.run, a.path, a.success)
    elif a.command == "plan-save":
        if not a.run or not a.commit or not a.review_path:
            raise StateError("Missing private plan inputs")
        plan_save(a.key, a.run, a.commit, a.path, a.review_path, a.allow_empty)
    elif a.command == "plan-fetch":
        if not a.plan_run or not a.commit or not a.plan_sha256:
            raise StateError("Missing approved plan inputs")
        plan_fetch(a.key, a.plan_run, a.commit, a.plan_sha256, a.path, a.allow_empty)
    elif a.command == "rescue":
        rescue(a.key, a.run, a.path)
    print("Protected state " + a.command + " verified")


if __name__ == "__main__":
    try:
        main()
    except (StateError, KeyError, ValueError, OSError, json.JSONDecodeError):
        print("Protected state operation blocked; inspect private state release and reconcile", file=sys.stderr)
        sys.exit(1)
