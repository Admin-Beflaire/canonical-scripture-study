"""Private GitHub release-backed Terraform state protocol for trusted Actions.

Immutable, run-attempt-qualified begin/state/receipt assets. An unfinished or
failed attempt blocks all subsequent runs until a separately reviewed repair.
No state bytes or provider response bodies are printed to public logs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request

REPOSITORY = os.environ.get("PLATFORM_STATE_REPO", "")
if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", REPOSITORY) or REPOSITORY == os.environ.get("GITHUB_REPOSITORY"):
    raise RuntimeError("Private state repository must be configured separately")
TAG = "platform-state-v1"
ROOT = "https://api.github.com"
KEYS = {"github", "cloudflare"}
SAFE_ID = re.compile(r"^[0-9]{1,20}-[0-9]{1,5}$")


class StateError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def request(method, path, data=None, binary=False, upload=False):
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
        with urllib.request.urlopen(req, timeout=30) as response:
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
    if obj is None:
        raise StateError("Protected state release absent; initialize under owner authorization")
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
    try:
        rel = release()
    except StateError:
        if allow_missing:
            return None, None
        raise
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
        if receipt.get("run") != run or receipt.get("key") != key:
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
    rel, _ = inventory(key, allow_missing=True)
    if rel is None:
        rel = release(create=True)
    upload(rel, names(key, run)[0], json.dumps({"key": key, "run": run,
                                                "stage": "begin"}, sort_keys=True).encode())


def finish(key, run, state_path, success):
    if key not in KEYS or not SAFE_ID.fullmatch(run):
        raise StateError("Invalid state identity")
    rel = release()
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


def main():
    p = argparse.ArgumentParser()
    p.add_argument("command", choices=("restore", "begin", "finish"))
    p.add_argument("--key", required=True, choices=sorted(KEYS))
    p.add_argument("--run")
    p.add_argument("--path")
    p.add_argument("--allow-empty", action="store_true")
    p.add_argument("--success", action="store_true")
    a = p.parse_args()
    if a.command in ("begin", "finish") and (not a.run or not SAFE_ID.fullmatch(a.run)):
        raise StateError("Run must be the fixed GitHub run-id/attempt")
    if a.command in ("restore", "finish") and not a.path:
        raise StateError("Missing state path")
    if a.command == "restore":
        restore(a.key, a.path, a.allow_empty)
    elif a.command == "begin":
        begin(a.key, a.run)
    else:
        finish(a.key, a.run, a.path, a.success)
    print("Protected state " + a.command + " verified")


if __name__ == "__main__":
    try:
        main()
    except (StateError, KeyError, ValueError, OSError, json.JSONDecodeError):
        print("Protected state operation blocked; inspect private state release and reconcile", file=sys.stderr)
        sys.exit(1)
