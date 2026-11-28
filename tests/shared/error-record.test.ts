import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {
  OwnMessageError,
  errorRecord,
  recordText,
} from '../../packages/shared/src/index.ts';

class OwnError extends OwnMessageError {}

function raised(error: Error): Error {
  try {
    throw error;
  } catch (caught) {
    return caught as Error;
  }
}

const fields = {tool: 'control', stage: 'advance', code: 'progression_failed'};

test('our own message is kept and located', () => {
  const record = errorRecord(
    raised(new OwnError('GitHub POST refused with HTTP 422')),
    fields,
  );
  assert.equal(record.message, 'GitHub POST refused with HTTP 422');
  assert.equal(record.error, 'OwnError');
  assert.ok(record.at?.some(frame => frame.file === 'error-record.test.ts'));
});

test('a foreign message is never stored', () => {
  for (const error of [
    new Error('SECRET-TOKEN in text'),
    new TypeError('wording of the source'),
    'plain string with SECRET-TOKEN',
    {message: 'SECRET-TOKEN'},
  ]) {
    const text = recordText(errorRecord(error, fields));
    assert.ok(!text.includes('SECRET'), text);
    assert.ok(!text.includes('wording'), text);
  }
  assert.equal(errorRecord(new TypeError('x'), fields).error, 'TypeError');
});

test('the status comes from the error or the call', () => {
  const refused = Object.assign(new OwnError('refused'), {status: 503});
  assert.equal(errorRecord(refused, fields).http, 503);
  assert.equal(
    errorRecord(new Error('x'), {...fields, httpStatus: 404}).http,
    404,
  );
  assert.equal(
    errorRecord(new Error('x'), {...fields, httpStatus: 99999}).http,
    undefined,
  );
});

test('only plain identifiers and counts are accepted', () => {
  const record = errorRecord(new Error('x'), {
    ...fields,
    ids: {
      source_revision: 'sbl-1.2',
      'bad key': 'a',
      wording: 'ἐν ἀρχῇ ἦν ὁ λόγος',
      position: 1204,
    },
    counts: {rows: 12, name: 'text', negative: -1},
    exitCode: 1,
    providerCode: 10000,
  });
  assert.deepEqual(record.ids, {position: 1204, source_revision: 'sbl-1.2'});
  assert.deepEqual(record.counts, {rows: 12});
  assert.deepEqual([record.exit, record.provider_code], [1, 10000]);
});

test('the TypeScript and Python records agree on field names and order', () => {
  const record = errorRecord(new Error('x'), {
    ...fields,
    ids: {unit: 'u'},
    counts: {rows: 1},
    names: ['size'],
    exitCode: 1,
    httpStatus: 500,
    providerCode: 'E1',
  });
  const keys = Object.keys(JSON.parse(recordText(record)));
  assert.deepEqual(keys, [...keys].sort());
  assert.deepEqual(keys, [
    'at',
    'code',
    'counts',
    'error',
    'exit',
    'http',
    'ids',
    'names',
    'outcome',
    'provider_code',
    'stage',
    'tool',
    'v',
  ]);
});

test('the TypeScript and Python records give the same text for the same condition', () => {
  const python =
    process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const script = `from css_shared.error_record import error_record, record_text
print(record_text(error_record(None, tool='control', stage='advance', code='progression_failed', outcome='uncertain', ids={'task': 'task-1', 'unit': 'gen-1', 'bad key': 'x'}, counts={'attempt': 2}, names=['size', 'name'], exit_code=1, http_status=503, provider_code=10000)), end='')`;
  const env = {
    ...process.env,
    PYTHONPATH: 'packages/shared-python/src',
  };
  const fromPython = execFileSync(python, ['-c', script], {
    encoding: 'utf8',
    env,
  });
  const fromTypeScript = recordText(
    errorRecord(undefined, {
      tool: 'control',
      stage: 'advance',
      code: 'progression_failed',
      outcome: 'uncertain',
      ids: {task: 'task-1', unit: 'gen-1', 'bad key': 'x'},
      counts: {attempt: 2},
      names: ['size', 'name'],
      exitCode: 1,
      httpStatus: 503,
      providerCode: 10000,
    }),
  );
  assert.equal(fromTypeScript, fromPython);
});
