"""Report non-sensitive facts about one failed Cloudflare provisioning attempt."""
import hashlib
import json
import re

import platform_state


RUN = '44883634337-1'


def summarize(receipt_bytes, state_bytes, log_bytes):
    receipt = json.loads(receipt_bytes)
    state = json.loads(state_bytes)
    if receipt.get('key') != 'cloudflare' or receipt.get('run') != RUN:
        raise ValueError('Receipt does not identify the expected attempt')
    if (receipt.get('sha256') != hashlib.sha256(state_bytes).hexdigest()
            or receipt.get('bytes') != len(state_bytes)):
        raise ValueError('Saved state does not match its receipt')
    resources = state.get('resources')
    if not isinstance(resources, list):
        raise ValueError('Saved state resources unavailable')
    text = log_bytes.decode('utf-8', errors='replace')
    apply = text.partition('=== apply ===')[2]
    categories = {
        'authentication_or_authorization': bool(re.search(
            r'authentication error|unauthori[sz]ed|forbidden|permission denied|not authorized', apply, re.I)),
        'already_exists': bool(re.search(r'already exists|already been taken', apply, re.I)),
        'network_or_timeout': bool(re.search(r'timed? out|timeout|connection refused|network is unreachable', apply, re.I)),
        'terraform_error_present': bool(re.search(r'\bError:', apply, re.I)),
    }
    return {
        'receipt_outcome': receipt.get('outcome'),
        'state_matches_receipt': True,
        'state_contains_kv_resource': any(
            isinstance(row, dict) and row.get('type') == 'cloudflare_workers_kv_namespace'
            and row.get('name') == 'verified_word_cache' and row.get('instances')
            for row in resources),
        'apply_log_present': bool(apply),
        'error_categories': categories,
    }


def main():
    metadata = platform_state.request('GET', '/repos/' + platform_state.REPOSITORY)
    if not isinstance(metadata, dict) or metadata.get('private') is not True:
        raise ValueError('State repository is not private')
    release = platform_state.release()
    if not release:
        raise ValueError('Private state release not found')
    found = {item['name']: item for item in platform_state.assets(release)}
    prefix = 'cloudflare--' + RUN + '--'
    names = [prefix + 'receipt.json', prefix + 'state.tfstate',
             'log--cloudflare--' + RUN + '--diagnostics.txt']
    data = [platform_state.download(found[name]) for name in names]
    print(json.dumps(summarize(*data), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # State, credentials and provider errors can be private: never print them.
        print('Protected diagnosis unavailable')
        raise SystemExit(1)
