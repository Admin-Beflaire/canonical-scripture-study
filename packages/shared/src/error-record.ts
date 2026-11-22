/**
 * One safe error record, built where an error is caught. It is the TypeScript twin of
 * `css_shared.error_record` and has the same fields.
 *
 * The record says what failed and where, and nothing else: no secrets, no state bytes, no
 * source text. That is decided here, once, from the error's class and our own fields; it is
 * never recovered afterwards by filtering text.
 *
 * - Only an error of a class that extends `OwnMessageError` has its message stored. Such a
 *   message is written by our code from fixed words and identifiers. A message from a
 *   library, a provider or the platform is never stored: the record keeps the class name and
 *   our own context instead.
 * - Identifiers and counts are accepted only in a plain shape; anything else is left out.
 */

export const RECORD_VERSION = 1;
export const MAX_TEXT = 1000;
const MAX_MESSAGE = 200;
const MAX_FRAMES = 3;
const MAX_VALUES = 8;
const OUTCOMES = [
  'failed',
  'cancelled',
  'blocked',
  'uncertain',
  'changes',
] as const;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const VALUE = /^[A-Za-z0-9._:/@#+=-]{1,80}$/;
const FRAME = /^\s*at (?:(.+?) \()?(?:.*[\\/])?([^\\/:()]+):(\d+):\d+\)?\s*$/;

/** Marks an error whose message our code wrote from fixed words and identifiers. */
export class OwnMessageError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

export interface CodeLocation {
  file: string;
  function: string;
  line: number;
}

export interface ErrorRecord {
  v: typeof RECORD_VERSION;
  tool: string;
  stage: string;
  outcome: (typeof OUTCOMES)[number];
  code: string;
  error?: string;
  http?: number;
  provider_code?: string | number;
  exit?: number;
  ids?: Record<string, string | number>;
  counts?: Record<string, number>;
  names?: string[];
  at?: CodeLocation[];
  message?: string;
}

export interface ErrorRecordFields {
  /** The workflow, Worker or tool. */
  tool: string;
  /** The step it was in. */
  stage: string;
  /** Our own error code. */
  code: string;
  outcome?: ErrorRecord['outcome'];
  ids?: Record<string, unknown>;
  counts?: Record<string, unknown>;
  /** Plain names, such as the attributes a plan would change. */
  names?: string[];
  exitCode?: number;
  httpStatus?: number;
  providerCode?: string | number;
}

function isCount(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) < 1e12
  );
}

function plain(
  values: Record<string, unknown> | undefined,
  numbersOnly: boolean,
): Record<string, string | number> | undefined {
  const kept = Object.entries(values ?? {})
    .filter(([key]) => CODE.test(key))
    .flatMap(([key, value]): [string, string | number][] => {
      if (isCount(value)) return [[key, value]];
      if (!numbersOnly && typeof value === 'string' && VALUE.test(value))
        return [[key, value]];
      return [];
    })
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(0, MAX_VALUES);
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

function locations(error: Error): CodeLocation[] {
  const ours = (error.stack ?? '')
    .split('\n')
    .flatMap(line => {
      const found = FRAME.exec(line);
      if (!found || line.includes('node_modules') || line.includes('node:'))
        return [];
      return [
        {
          file: found[2],
          function: found[1]?.split(' ').pop() ?? '<anonymous>',
          line: Number(found[3]),
        },
      ];
    })
    .reverse();
  return ours.slice(-MAX_FRAMES);
}

function ownMessage(error: Error): string | undefined {
  if (!(error instanceof OwnMessageError)) return undefined;
  const text = [...error.message]
    .map(c => (c >= ' ' && c !== '\x7f' ? c : ' '))
    .join('');
  return (
    text.split(/\s+/).filter(Boolean).join(' ').slice(0, MAX_MESSAGE) ||
    undefined
  );
}

function inRange(value: unknown, low: number, high: number): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= low &&
    (value as number) <= high
  );
}

function errorClass(error: unknown): string | undefined {
  if (error instanceof Error)
    return NAME.test(error.name) ? error.name : 'Error';
  return error === undefined || error === null ? undefined : 'NonError';
}

/** The numbers a provider or command gave: HTTP status, provider error code and exit code. */
function statuses(
  error: unknown,
  fields: ErrorRecordFields,
): Partial<ErrorRecord> {
  const status =
    fields.httpStatus ?? (error as {status?: unknown} | null)?.status;
  const code = fields.providerCode;
  const plainCode =
    isCount(code) || (typeof code === 'string' && VALUE.test(code));
  return {
    ...(inRange(status, 100, 599) ? {http: status} : {}),
    ...(plainCode ? {provider_code: code} : {}),
    ...(inRange(fields.exitCode, 0, 255) ? {exit: fields.exitCode} : {}),
  };
}

/** The plain identifiers, counts and names. */
function details(fields: ErrorRecordFields): Partial<ErrorRecord> {
  const names = (fields.names ?? [])
    .filter(name => typeof name === 'string' && CODE.test(name))
    .slice(0, MAX_VALUES)
    .sort();
  return {
    ids: plain(fields.ids, false),
    counts: plain(fields.counts, true) as Record<string, number> | undefined,
    ...(names.length > 0 ? {names} : {}),
  };
}

/** The code locations and our own message of an error. */
function origin(error: unknown): Partial<ErrorRecord> {
  if (!(error instanceof Error)) return {};
  const at = locations(error);
  return {...(at.length > 0 ? {at} : {}), message: ownMessage(error)};
}

/** The safe record of `error` (or of a condition that is not an error). */
export function errorRecord(
  error: unknown,
  fields: ErrorRecordFields,
): ErrorRecord {
  const {tool, stage, code, outcome = 'failed'} = fields;
  if (
    !NAME.test(tool) ||
    !NAME.test(stage) ||
    !CODE.test(code) ||
    !OUTCOMES.includes(outcome)
  )
    throw new Error('Error record needs a plain tool, stage, code and outcome');
  const record = {
    v: RECORD_VERSION,
    tool,
    stage,
    outcome,
    code,
    error: errorClass(error),
    ...statuses(error, fields),
    ...details(fields),
    ...origin(error),
  };
  // Only the fields that were found are kept.
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as unknown as ErrorRecord;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, item]) => [key, sorted(item)]),
    );
  return value;
}

/**
 * The record as compact JSON of at most `MAX_TEXT` characters. If it is too long, parts give
 * way in this order: older code locations, the message, the counts, the identifiers.
 */
export function recordText(record: ErrorRecord): string {
  const shrunk: Partial<ErrorRecord> = {...record};
  const steps: (() => void)[] = [
    () => {
      if (shrunk.at && shrunk.at.length > 1) shrunk.at = shrunk.at.slice(-1);
    },
    () => delete shrunk.at,
    () => delete shrunk.message,
    () => delete shrunk.counts,
    () => delete shrunk.names,
    () => delete shrunk.ids,
  ];
  for (const step of [undefined, ...steps]) {
    step?.();
    const text = JSON.stringify(sorted(shrunk)).replace(
      /[\u007f-￿]/g,
      c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
    );
    if (text.length <= MAX_TEXT) return text;
  }
  throw new Error('Error record does not fit its limit');
}

/** One log line for a Worker: the record as JSON text. */
export function logError(record: ErrorRecord): void {
  console.error(recordText(record));
}

/** Build the record where an error is caught and log it. Never throws: logging cannot change a result. */
export function reportError(error: unknown, fields: ErrorRecordFields): void {
  try {
    logError(errorRecord(error, fields));
  } catch {
    // A diagnostic never changes the outcome of the work it reports on.
  }
}
