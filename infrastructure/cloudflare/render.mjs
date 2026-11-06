import { chmodSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @param {unknown} input @returns {Record<string, string | number | boolean>} */
export function validateInstance(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Instance object required');
  const v = /** @type {Record<string, unknown>} */ (input);
  const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const patterns = {
    ACCOUNT_ID: /^[a-f0-9]{32}$/, ZONE_ID: /^[a-f0-9]{32}$/,
    ZONE_NAME: DNS_NAME,
    INSTANCE: /^[a-z0-9]([a-z0-9-]{0,23}[a-z0-9])?$/,
    STUDY_HOSTNAME: DNS_NAME,
    CONTROL_HOSTNAME: DNS_NAME,
    DATABASE_ID: /^[a-f0-9-]{36}$/,
    ACCESS_ISSUER: /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/,
    STUDY_AUDIENCE: /^[a-f0-9]{64}$/, CONTROL_AUDIENCE: /^[a-f0-9]{64}$/, JOB_AUDIENCE: /^[a-f0-9]{64}$/,
  };
  for (const [key, pattern] of Object.entries(patterns)) {
    if (typeof v[key] !== 'string' || !pattern.test(v[key])) throw new Error(`Invalid or missing ${key}`);
  }
  const zone = /** @type {string} */ (v.ZONE_NAME);
  for (const key of ['STUDY_HOSTNAME', 'CONTROL_HOSTNAME']) {
    if (!(/** @type {string} */ (v[key])).endsWith(`.${zone}`) || zone.endsWith('workers.dev')) throw new Error('Host must be inside the configured custom zone');
  }
  if (v.STUDY_HOSTNAME === v.CONTROL_HOSTNAME || new Set([v.STUDY_AUDIENCE, v.CONTROL_AUDIENCE, v.JOB_AUDIENCE]).size !== 3) throw new Error('Resource identities must be distinct');
  const caps = { MAX_PAGE_BYTES: 65536, REQUEST_BYTES: 262144, MAX_D1_CALLS: 50, MAX_SUBREQUESTS: 50, CPU_BUDGET_MS: 10 };
  for (const [key, cap] of Object.entries(caps)) {
    if (!Number.isSafeInteger(v[key]) || Number(v[key]) < 1 || Number(v[key]) > cap) throw new Error(`Invalid or missing ${key}`);
  }
  if (Number(v.MAX_PAGE_BYTES) > Number(v.REQUEST_BYTES) || Number(v.MAX_D1_CALLS) > Number(v.MAX_SUBREQUESTS)) throw new Error('Inconsistent request budgets');
  if (typeof v.ENHANCEMENTS !== 'boolean') throw new Error('Explicit ENHANCEMENTS boolean required');
  const known = new Set([...Object.keys(patterns), ...Object.keys(caps), 'ENHANCEMENTS']);
  if (Object.keys(v).some(k => !known.has(k))) throw new Error('Unknown instance input (secrets do not belong here)');
  return /** @type {Record<string, string | number | boolean>} */ (v);
}

/** @param {unknown} input @param {string} root */
export function renderWorkerConfigs(input, root) {
  const v = validateInstance(input);
  return Object.fromEntries(['study', 'control'].map(role => {
    const path = role === 'study' ? 'services/study' : 'services/maintenance/control';
    const template = readFileSync(resolve(root, path, 'wrangler.jsonc'), 'utf8');
    const rendered = template.replace(/"\{\{([A-Z0-9_]+)\}\}"/g, (_, key) => {
      if (!Object.hasOwn(v, key)) throw new Error(`Unresolved ${key}`);
      return JSON.stringify(v[key]);
    }).replace(/\{\{INSTANCE\}\}/g, String(v.INSTANCE));
    if (/\{\{|\}\}/.test(rendered)) throw new Error('Unresolved configuration placeholder');
    return [role, JSON.parse(rendered)];
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '../..');
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const rendered = renderWorkerConfigs(input, root);
  // Fixed ignored directory; no instance values in logs or source files.
  const directory = resolve(root, 'dist/config');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  for (const [role, config] of Object.entries(rendered)) {
    const output = resolve(directory, `${role}.json`);
    writeFileSync(output, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    chmodSync(output, 0o600);
  }
}
