"""One-off recovery of the known failed Cloudflare state; never print state bytes."""
import hashlib  # noqa: F401
import json
import os
from pathlib import Path
import re
import sys

import platform_state as state

FAILED = '44883634337-1'
NAMESPACE = '8071e577bb1a49ddb0aad5d3f230bc31'


def verify_plan(plan):
    """Allow no changes except volatile, provider-computed D1 metadata."""
    computed = {'file_size', 'num_tables', 'version'}
    if not isinstance(plan, dict) or not isinstance(plan.get('resource_changes'), list):
        raise state.StateError('Invalid provider plan')
    for item in plan['resource_changes']:
        change = item.get('change', {})
        actions = change.get('actions')
        if actions == ['no-op']:
            continue
        if item.get('mode') == 'data' and actions == ['read']:
            continue
        if item.get('address') != 'cloudflare_d1_database.data' or actions != ['update']:
            raise state.StateError('Plan proposes an unrelated resource change')
        before, after = change.get('before'), change.get('after')
        unknown = change.get('after_unknown') or {}
        if (not isinstance(before, dict) or not isinstance(after, dict) or not isinstance(unknown, dict)
                or any(v and k not in computed for k, v in unknown.items())
                or {k: v for k, v in before.items() if k not in computed}
                != {k: v for k, v in after.items() if k not in computed}):
            raise state.StateError('Plan proposes a database configuration change')


def verified_source():
    metadata = state.request('GET', '/repos/' + state.REPOSITORY)
    if not isinstance(metadata, dict) or metadata.get('private') is not True or metadata.get('visibility') != 'private':
        raise state.StateError('State repository is not private')
    rel = state.release()
    if not rel:
        raise state.StateError('Missing release')
    found = {x['name']: x for x in state.assets(rel)}
    begin, snapshot, receipt_name = state.names('cloudflare', FAILED)
    if not all(x in found for x in (begin, snapshot, receipt_name)):
        raise state.StateError('Incomplete failed attempt')
    if 'reconciled--cloudflare--' + FAILED + '.json' in found:
        raise state.StateError('Already reconciled')
    attempts = [m.group(1) for name in found if (m := re.fullmatch(r'cloudflare--([0-9]+-[0-9]+)--begin\.json', name))]
    if not attempts or max(tuple(map(int, x.split('-'))) for x in attempts) != tuple(map(int, FAILED.split('-'))):
        raise state.StateError('Unexpected subsequent attempt')
    receipt = json.loads(state.download(found[receipt_name]))
    data = state.download(found[snapshot])
    if (receipt.get('key') != 'cloudflare' or receipt.get('run') != FAILED
            or receipt.get('outcome') != 'uncertain' or receipt.get('sha256') != state.digest(data)
            or receipt.get('bytes') != len(data)):
        raise state.StateError('Failed snapshot mismatch')
    saved = json.loads(data)
    if any(x.get('type') == 'cloudflare_workers_kv_namespace' and x.get('name') == 'verified_word_cache'
           and x.get('instances') for x in saved.get('resources', [])):
        raise state.StateError('Namespace already present in failed state')
    return rel, receipt, data


def prepare(path):
    _, _, data = verified_source()
    target = Path(path)
    target.write_bytes(data)
    target.chmod(0o600)


def publish(path, run):
    if not state.SAFE_ID.fullmatch(run) or tuple(map(int, run.split('-'))) <= tuple(map(int, FAILED.split('-'))):
        raise state.StateError('Invalid recovery attempt')
    rel, receipt, source = verified_source()
    data = Path(path).read_bytes()
    old, new = json.loads(source), json.loads(data)
    bindings = new['outputs']['bindings']['value']
    matches = [x for x in new['resources'] if x.get('type') == 'cloudflare_workers_kv_namespace'
               and x.get('name') == 'verified_word_cache' and x.get('instances')]
    if (new.get('lineage') != old.get('lineage') or new.get('serial', 0) <= old.get('serial', 0)
            or len(matches) != 1 or len(matches[0]['instances']) != 1
            or matches[0]['instances'][0]['attributes'].get('id') != NAMESPACE
            or bindings.get('verified_word_cache_namespace_id') != NAMESPACE):
        raise state.StateError('Recovered state does not match expected namespace')
    begin, snapshot, done = state.names('cloudflare', run)
    marker = 'reconciled--cloudflare--' + FAILED + '.json'
    assets = {x['name'] for x in state.assets(rel)}
    if any(x in assets for x in (begin, snapshot, done, marker)):
        raise state.StateError('Recovery assets already exist')
    state.upload(rel, begin, json.dumps({'key': 'cloudflare', 'run': run, 'stage': 'recovery'}, sort_keys=True).encode())
    saved = state.upload(rel, snapshot, data)
    if state.digest(state.download(saved)) != state.digest(data):
        raise state.StateError('Recovered state readback mismatch')
    result = {'key': 'cloudflare', 'run': run, 'sha256': state.digest(data), 'bytes': len(data), 'outcome': 'success'}
    state.upload(rel, done, json.dumps(result, sort_keys=True).encode())
    record = {'key': 'cloudflare', 'failed_run': FAILED, 'failed_sha256': receipt['sha256'],
              'baseline_run': run, 'baseline_sha256': result['sha256']}
    state.upload(rel, marker, json.dumps(record, sort_keys=True).encode())
    state.restore('cloudflare', path)


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'prepare':
            prepare(sys.argv[2])
        elif sys.argv[1] == 'publish':
            publish(sys.argv[2], os.environ['ATTEMPT_ID'])
        elif sys.argv[1] == 'verify-plan':
            verify_plan(json.loads(Path(sys.argv[2]).read_text()))
        else:
            raise ValueError('Unknown operation')
        print('Recovery phase verified')
    except Exception:
        print('Recovery blocked; preserve private state and inspect diagnostics', file=sys.stderr)
        sys.exit(1)
