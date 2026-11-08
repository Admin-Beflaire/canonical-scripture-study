"""Authorized deployment runner. Tool/provider details stay in private diagnostics."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request


class DeploymentError(Exception):
    pass


def run(command, log, env=None):
    # No shell, inherited deployment credentials, raw exception text or tool output.
    safe_env = {k: v for k, v in os.environ.items() if k not in {
        "CLOUDFLARE_API_TOKEN", "DEPLOYMENT_ACCESS_CLIENT_ID", "DEPLOYMENT_ACCESS_CLIENT_SECRET", "PLATFORM_STATE_TOKEN"}}
    safe_env.update(env or {})
    result = subprocess.run(command, stdout=log, stderr=log, env=safe_env)
    if result.returncode:
        raise DeploymentError("Deployment phase failed")


def api(path, token, payload=None):
    request = urllib.request.Request("https://api.cloudflare.com/client/v4/" + path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.load(response)
    if data.get("success") is not True:
        raise DeploymentError("Provider check failed")
    return data["result"]


def compatible(versions, supported):
    if not isinstance(versions, dict) or not versions or any(
            key not in supported or value not in supported[key] for key, value in versions.items()):
        raise DeploymentError("Selected data is incompatible with this code")


def selection(query, supported):
    exists = query("SELECT name FROM sqlite_master WHERE type='table' AND name='release_selection'")
    if not exists:
        # Only a genuinely empty database can take the initial migrations.
        if query("SELECT name FROM sqlite_master WHERE type='table' AND name='releases'"):
            raise DeploymentError("Incomplete schema")
        return None
    rows = query("SELECT s.current_release_id, r.schema_versions_json FROM release_selection s LEFT JOIN releases r ON r.id=s.current_release_id WHERE s.singleton_id=1")
    if len(rows) != 1:
        raise DeploymentError("Invalid release selection")
    row = rows[0]
    if row["current_release_id"] is not None:
        compatible(json.loads(row["schema_versions_json"]), supported)
    return row["current_release_id"]


def check_bindings(settings, config):
    bindings = {b["name"]: b for b in settings["bindings"]}
    expected = config["d1_databases"][0]
    if bindings.get("DATA_DB", {}).get("id") != expected["database_id"]:
        raise DeploymentError("D1 binding mismatch")
    if bindings.get("PRIVATE_OBJECTS", {}).get("bucket_name") != config["r2_buckets"][0]["bucket_name"]:
        raise DeploymentError("R2 binding mismatch")
    for key, value in config["vars"].items():
        actual = bindings.get(key, {})
        if actual.get("type") == "json":
            actual_value = actual.get("json")
        else:
            actual_value = actual.get("text")
        if actual_value != value:
            raise DeploymentError("Runtime setting mismatch")


def deploy(root, trusted, work, role):
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    check_id = os.environ["DEPLOYMENT_ACCESS_CLIENT_ID"]
    check_secret = os.environ["DEPLOYMENT_ACCESS_CLIENT_SECRET"]
    if not token or not check_id or not check_secret:
        raise DeploymentError("Missing deployment credentials")
    config_path = root / "dist/config" / (role + ".json")
    config = json.loads(config_path.read_text())
    if config.get("vars", {}).get("DEPLOYMENT_CLIENT_ID") != check_id:
        raise DeploymentError("Selected Worker does not enforce deployment identity")
    supported = json.loads((root / "infrastructure/github/deployment/compatibility.json").read_text())
    study_fit = os.environ.get("STUDY_FIT") == "true"
    if study_fit:
        if role != "study" or os.environ.get("APPROVAL") != "DEPLOY-FIT":
            raise DeploymentError("Fixture deployment approval required")
        supported = {**supported, "index_manifest": ["1"]}
        config["observability"]["logs"].update({"invocation_logs": True, "head_sampling_rate": 1})
    account = config["account_id"]
    database = config["d1_databases"][0]["database_id"]
    def query(sql):
        result = api(f"accounts/{account}/d1/database/{database}/query", token, {"sql": sql})
        if len(result) != 1 or result[0].get("success") is not True:
            raise DeploymentError("D1 check failed")
        return result[0]["results"]
    with (work / "deployment.log").open("a") as log:
        current = selection(query, supported)
        if study_fit and current != "ix-release":
            raise DeploymentError("Selected synthetic fixture required")
        # Use the trusted dispatch revision's single forward migration sequence,
        # including when selected code is an older compatible revert.
        migration_dir = trusted / "schemas/migrations"
        names = {p.name for p in migration_dir.glob("*.sql")}
        if query("SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'"):
            if any(r["name"] not in names for r in query("SELECT name FROM d1_migrations")):
                raise DeploymentError("Database is ahead of the trusted migration sequence")
        config["d1_databases"][0]["migrations_dir"] = str(migration_dir)
        config_path.write_text(json.dumps(config))
        provider_env = {"CLOUDFLARE_API_TOKEN": token, "CLOUDFLARE_ACCOUNT_ID": account}
        wrangler = str(root / "node_modules/.bin/wrangler")
        run([wrangler, "d1", "migrations", "apply", "DATA_DB", "--remote", "--config", str(config_path)], log, provider_env)
        if selection(query, supported) != current:
            raise DeploymentError("Selection changed during migration; retry against current data")
        run([wrangler, "deploy", "--config", str(config_path)], log, provider_env)
        settings = api(f"accounts/{account}/workers/scripts/{config['name']}/settings", token)
        check_bindings(settings, config)
        alternate = api(f"accounts/{account}/workers/scripts/{config['name']}/subdomain", token)
        if alternate.get("enabled") is not False or alternate.get("previews_enabled") is not False:
            raise DeploymentError("Alternate Worker access is enabled")
        run(["node", str(trusted / "infrastructure/github/deployment/smoke.mjs"),
             config["vars"]["HOSTNAME"]], log, {
                 "DEPLOYMENT_ACCESS_CLIENT_ID": check_id,
                 "DEPLOYMENT_ACCESS_CLIENT_SECRET": check_secret})
        if selection(query, supported) != current:
            raise DeploymentError("Selection changed during deployment; recheck compatibility")
        receipt = {"commit": os.environ["SELECTED_SHA"], "run": os.environ["ATTEMPT_ID"],
                   "target": role, "study_fit": study_fit, "selected_data": current, "http_checks": "passed",
                   "host_observations": "not_performed"}
        (work / "receipt.json").write_text(json.dumps(receipt))


def diagnostics(trusted, work):
    # Reuse the checked private release transport, with a separate diagnostic tag.
    spec = importlib.util.spec_from_file_location("private_transport", trusted / "infrastructure/github/platform_state.py")
    transport = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transport)
    transport.TAG = "deployment-diagnostics"
    metadata = transport.request("GET", "/repos/" + transport.REPOSITORY)
    if not metadata or metadata.get("private") is not True or metadata.get("visibility") != "private":
        raise DeploymentError("Diagnostics destination must be private")
    rel = transport.release(create=True)
    attempt = os.environ["ATTEMPT_ID"]
    if not transport.SAFE_ID.fullmatch(attempt):
        raise DeploymentError("Invalid run identity")
    # Reserve room for this entire attempt before uploading any asset.
    pending = [name for name in ("build.log", "deployment.log", "receipt.json")
               if (work / name).exists()]
    if len(transport.assets(rel)) + len(pending) > 1000:
        raise DeploymentError("Private diagnostics release is full")
    # Only captured tool output and the receipt; never credentials or instance files.
    for name in pending:
        path = work / name
        if path.exists():
            data = path.read_bytes()
            saved = transport.upload(rel, f"deploy--{attempt}--{name}", data)
            if transport.digest(transport.download(saved)) != transport.digest(data):
                raise DeploymentError("Private diagnostics integrity failed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=("deploy", "diagnostics"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--trusted", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--target", choices=("study", "control"), required=True)
    args = parser.parse_args()
    if args.phase == "deploy":
        deploy(args.root, args.trusted, args.work, args.target)
    else:
        diagnostics(args.trusted, args.work)
    print("Deployment " + args.phase + " phase passed")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        work = next((sys.argv[i+1] for i, arg in enumerate(sys.argv[:-1]) if arg == "--work"), None)
        if work and Path(work).is_dir():
            # Fixed failure types are useful without persisting credential-bearing exceptions.
            with (Path(work) / "deployment.log").open("a") as log:
                log.write(type(exc).__name__ + ": " + (str(exc) if isinstance(exc, DeploymentError) else "Private operation failed") + "\n")
        # Provider errors/JSON/body/paths can contain private identifiers.
        print("Deployment phase blocked; inspect private diagnostics", file=sys.stderr)
        sys.exit(1)
