import { canonicalJson, sha256Hex } from '../read/bytes.ts';
import { ReadError } from '../read/states.ts';

/** A continuation carries the normalized workload hash, the operator, its position and its
 *  deterministic order key. It is not signed: nothing in it is trusted. On every use the hash
 *  is recomputed from the submitted workload and the position/order key are checked against
 *  that operator's own query and read bounds, so altered state can only select data the
 *  submitted workload could read anyway. It pins no release and no conversation. */
export interface Continuation { op: string; pos: unknown; key: unknown }

export type PositionCheck = (pos: unknown, key: unknown, workload: unknown) => boolean;

const MAX_STATE_CHARS = 2048;
const B64URL = /^[A-Za-z0-9_-]+$/;

export async function workloadHash(workload: unknown): Promise<string> { return sha256Hex(canonicalJson(workload)); }

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function fromBase64Url(token: string): string {
  const binary = atob(token.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - token.length % 4) % 4));
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}

export async function encodeContinuation(workload: unknown, state: Continuation): Promise<string> {
  const token = toBase64Url(canonicalJson({ v: 1, h: await workloadHash(workload), op: state.op, pos: state.pos, k: state.key }));
  if (token.length > MAX_STATE_CHARS) throw new ReadError('exceeds_limits', 'Continuation state too large');
  return token;
}

/** Rejects malformed, foreign-workload or out-of-bounds state before any read. */
export async function resumeContinuation(token: unknown, workload: unknown, checks: Readonly<Record<string, PositionCheck>>): Promise<Continuation> {
  const invalid = (detail: string): never => { throw new ReadError('invalid_request', `Continuation rejected: ${detail}`); };
  if (typeof token !== 'string' || token.length < 1 || token.length > MAX_STATE_CHARS || !B64URL.test(token)) return invalid('malformed');
  let state: Record<string, unknown>;
  try { state = JSON.parse(fromBase64Url(token)); } catch { return invalid('malformed'); }
  if (!state || typeof state !== 'object' || Array.isArray(state)
      || JSON.stringify(Object.keys(state).sort()) !== '["h","k","op","pos","v"]' || state.v !== 1) return invalid('unknown format');
  if (state.h !== await workloadHash(workload)) return invalid('it belongs to a different workload');
  if (typeof state.op !== 'string' || !Object.hasOwn(checks, state.op)) return invalid('unknown operator');
  if (!checks[state.op](state.pos, state.k, workload)) return invalid('position outside the operator bounds');
  return { op: state.op, pos: state.pos, key: state.k };
}
