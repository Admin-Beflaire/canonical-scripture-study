import { isIdentifier, isSafeCount, sha256Hex } from './bytes.ts';
import type { ReadSession } from './session.ts';
import { ReadError } from './states.ts';

/** A registered artifact row selected by the current release. The object key is internal:
 *  it is used for the R2 read and never returned to a host. */
export interface RegisteredArtifact { id: string; sha256: string; byte_count: number; format: string; registered_locator: string }

export const SUPPORTED_FORMATS: ReadonlySet<string> = new Set(['application/json', 'application/x-ndjson', 'text/utf-8']);
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
