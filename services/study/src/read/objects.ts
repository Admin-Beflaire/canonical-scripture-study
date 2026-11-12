import { isIdentifier, isSafeCount, sha256Hex } from './bytes.ts';
import type { ReadSession } from './session.ts';
import { ReadError } from './states.ts';

/** A registered artifact row selected by the current release. The object key is internal:
 *  it is used for the R2 read and never returned to a host. */
export interface RegisteredArtifact { id: string; sha256: string; byte_count: number; format: string; registered_locator: string }

export const SUPPORTED_FORMATS: ReadonlySet<string> = new Set(['application/json', 'application/x-ndjson',
  'application/x-ndjson; profile=index-directory', 'text/utf-8']);
const HEX = /^[0-9a-f]{64}$/;

/** Same portable object-key rules as the D1 schema; checked again before any R2 read. */
function portableKey(key: unknown): key is string {
  return isIdentifier(key, 1024) && !key.startsWith('/') && !key.includes('://') && !key.includes('\\')
    && !`/${key}/`.includes('/../') && !key.includes('?') && !key.includes('#');
}

export function artifactFrom(row: Record<string, unknown>, prefix = ''): RegisteredArtifact {
  const get = (name: string) => row[prefix + name];
  const artifact = { id: get('id'), sha256: get('sha256'), byte_count: get('byte_count'), format: get('format'), registered_locator: get('registered_locator') };
  if (!isIdentifier(artifact.id) || typeof artifact.sha256 !== 'string' || !HEX.test(artifact.sha256)
      || !isSafeCount(artifact.byte_count) || typeof artifact.format !== 'string' || !portableKey(artifact.registered_locator))
    throw new ReadError('corrupt', 'Inconsistent artifact registration');
  return artifact as RegisteredArtifact;
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Reads a whole registered object (`range` omitted) or one exact byte range of it.
 *  Checks format, bounds and allowance before reading, then length and SHA-256 after;
 *  only verified bytes are decoded as strict UTF-8. */
export async function readArtifact(session: ReadSession, artifact: RegisteredArtifact,
                                   range?: { offset: number; length: number; sha256: string }): Promise<string> {
  if (!SUPPORTED_FORMATS.has(artifact.format)) throw new ReadError('corrupt', `Unsupported artifact format for ${artifact.id}`);
  const offset = range?.offset ?? 0;
  const length = range?.length ?? artifact.byte_count;
  const digest = range?.sha256 ?? artifact.sha256;
  if (!isSafeCount(offset) || !isSafeCount(length) || offset + length > artifact.byte_count || (range && length === 0) || !HEX.test(digest))
    throw new ReadError('corrupt', `Range outside registered artifact ${artifact.id}`);
  const kind = range ? 'page' : 'object';
  if (!session.budget.canRead(length, kind)) {
    if (kind === 'page' && length > session.budget.limits.pageBytes) throw new ReadError('exceeds_limits', `Page larger than the configured cap in ${artifact.id}`);
    if (kind === 'object' && length > session.budget.limits.r2Bytes) throw new ReadError('exceeds_limits', `Object larger than the request allowance: ${artifact.id}`);
    throw new ReadError('budget', 'R2 read allowance used');
  }
  session.budget.spendRead(length, kind);
  let object;
  try { object = await session.objects.get(artifact.registered_locator, range ? { range: { offset, length } } : undefined); }
  catch { throw new ReadError('temporary_failure', `Object read failed for ${artifact.id}`); }
  if (!object) throw new ReadError('corrupt', `Registered object absent for ${artifact.id}`);
  let bytes;
  try { bytes = await object.arrayBuffer(); }
  catch { throw new ReadError('temporary_failure', `Object read failed for ${artifact.id}`); }
  if (bytes.byteLength !== length || await sha256Hex(bytes) !== digest)
    throw new ReadError('corrupt', `Digest or length mismatch in ${artifact.id}`);
  try { return decoder.decode(bytes); }
  catch { throw new ReadError('corrupt', `Invalid UTF-8 in ${artifact.id}`); }
}

/** Reads one contiguous byte range of a registered object and returns the verified slices
 *  inside it. Each slice is checked against its own SHA-256 and decoded as strict UTF-8, so
 *  neighbouring records (for example consecutive verses) cost one read, and a corrupt slice is
 *  reported alone (null) while the others stay usable. */
export async function readSlices(session: ReadSession, artifact: RegisteredArtifact, offset: number, length: number,
                                 slices: readonly { offset: number; length: number; sha256: string }[]): Promise<(string | null)[]> {
  if (!SUPPORTED_FORMATS.has(artifact.format)) throw new ReadError('corrupt', `Unsupported artifact format for ${artifact.id}`);
  if (!isSafeCount(offset) || !isSafeCount(length) || length === 0 || offset + length > artifact.byte_count
      || slices.some(s => !isSafeCount(s.offset) || !isSafeCount(s.length) || s.offset < offset || s.offset + s.length > offset + length || !HEX.test(s.sha256)))
    throw new ReadError('corrupt', `Range outside registered artifact ${artifact.id}`);
  if (!session.budget.canRead(length, 'page')) {
    if (length > session.budget.limits.pageBytes) throw new ReadError('exceeds_limits', `Range larger than the configured cap in ${artifact.id}`);
    throw new ReadError('budget', 'R2 read allowance used');
  }
  session.budget.spendRead(length, 'page');
  let object;
  try { object = await session.objects.get(artifact.registered_locator, { range: { offset, length } }); }
  catch { throw new ReadError('temporary_failure', `Object read failed for ${artifact.id}`); }
  if (!object) throw new ReadError('corrupt', `Registered object absent for ${artifact.id}`);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await object.arrayBuffer()); }
  catch { throw new ReadError('temporary_failure', `Object read failed for ${artifact.id}`); }
  if (bytes.byteLength !== length) throw new ReadError('corrupt', `Length mismatch in ${artifact.id}`);
  const out: (string | null)[] = [];
  for (const slice of slices) {
    const part = bytes.subarray(slice.offset - offset, slice.offset - offset + slice.length);
    if (await sha256Hex(part) !== slice.sha256) { out.push(null); continue; }
    try { out.push(decoder.decode(part)); } catch { out.push(null); }
  }
  return out;
}
