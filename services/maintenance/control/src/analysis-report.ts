import type {ArtifactRef} from './contracts.ts';
import {sha256} from './d1.ts';
import type {ObjectStore} from './release-check.ts';

const MAX_REPORT_BYTES = 1_000_000;
const PAGE_BYTES = 32_000;
const PAGE_ENTRIES = 20;
const encoder = new TextEncoder();

export function validAnalysisReference(reference: ArtifactRef): boolean {
  return (
    /^[0-9a-f]{64}$/.test(reference.sha256) &&
    reference.artifact_id === `analysis:${reference.sha256.slice(0, 32)}` &&
    reference.byte_count > 0 &&
    reference.byte_count <= MAX_REPORT_BYTES
  );
}

interface Report {
  method: string;
  input_sha256: string;
  input_byte_count: number;
  format: string;
  facts: Record<string, unknown>[];
}

/** The report is addressed by the result's verified digest, never by a caller's path. */
async function readReport(objects: ObjectStore | null, reference: ArtifactRef) {
  if (!validAnalysisReference(reference) || !objects?.read) return null;
  const data = await objects.read(
    `analysis-reports/${reference.sha256}.json`,
    reference.byte_count,
  );
  if (!data || (await sha256(data)) !== reference.sha256) return null;
  try {
    const report = JSON.parse(data) as Report;
    return report?.method === 'source-analysis/1' && Array.isArray(report.facts)
      ? report
      : null;
  } catch {
    return null;
  }
}

export async function analysisPage(
  objects: ObjectStore | null,
  reference: ArtifactRef,
  cursor?: string,
) {
  const report = await readReport(objects, reference);
  if (!report) return {status: 'unavailable'} as const;
  const {facts, ...basis} = report;
  const start = cursor === undefined ? 0 : Number.parseInt(cursor, 36);
  if (!Number.isSafeInteger(start) || start < 0 || start > facts.length)
    return {status: 'invalid_cursor'} as const;
  const page: typeof facts = [];
  let bytes = 0;
  for (const fact of facts.slice(start, start + PAGE_ENTRIES)) {
    bytes += encoder.encode(JSON.stringify(fact)).length + 1;
    if (bytes > PAGE_BYTES) break;
    page.push(fact);
  }
  const next = start + page.length;
  if (!page.length && next < facts.length)
    return {status: 'unavailable'} as const;
  return {
    status: 'available' as const,
    ...basis,
    sha256: reference.sha256,
    byte_count: reference.byte_count,
    facts: page,
    ...(next < facts.length ? {cursor: next.toString(36)} : {}),
  };
}
