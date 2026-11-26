import test from 'node:test';
import assert from 'node:assert/strict';
import {fromJsonSchema} from '@modelcontextprotocol/server';
import {
  platformServer,
  protocolHandler,
} from '../../packages/shared/src/platform.ts';
import {skillFile, taskSkills} from '../../packages/shared/src/skills.ts';
import {call} from './mcp-call.ts';
import {readSkills, SKILLS_EXTENSION, skillSupport} from './mcp-skills.ts';

const SKILLS = [
  {name: 'alpha', description: 'Alpha: "quoted" — text', text: 'Alpha ⚑ ǫ'},
  {name: 'beta-two', description: 'Second', text: 'Beta:\n\n- one rule'},
];

function fixture(serve: ReturnType<typeof taskSkills>, enhancements: boolean) {
  return protocolHandler(async () => {
    const server = platformServer('study', enhancements);
    await serve(server);
    server.registerTool(
      'fixture',
      {inputSchema: fromJsonSchema({type: 'object'})},
      async () => ({content: [{type: 'text' as const, text: 'ok'}]}),
    );
    return server;
  }, enhancements);
}

for (const enhancements of [false, true])
  test(`skills are listed and read with their digest, newer features ${enhancements ? 'on' : 'off'}`, async () => {
    const handler = fixture(taskSkills('study', SKILLS), enhancements);
    const read = await readSkills(handler);
    assert.deepEqual(
      read,
      SKILLS.map(skill => ({
        name: skill.name,
        description: skill.description,
        file: skillFile(skill),
      })),
    );
    await handler.close();
  });

test('a session with newer protocol features declares skill support', async () => {
  const on = fixture(taskSkills('study', SKILLS), true);
  const modern = await skillSupport(on, '2026-07-28');
  assert.deepEqual(modern.supportedVersions, ['2026-07-28']);
  assert.ok(modern.capabilities.extensions?.[SKILLS_EXTENSION]);
  await on.close();
  const off = fixture(taskSkills('study', SKILLS), false);
  const baseline = await skillSupport(off, '2025-11-25');
  assert.equal(baseline.protocolVersion, '2025-11-25');
  assert.ok(baseline.capabilities.extensions?.[SKILLS_EXTENSION]);
  assert.ok(baseline.capabilities.tools);
  await off.close();
});

test('skills that cannot be served are recorded and the tools keep working', async t => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (line: string) => logged.push(line));
  const broken = [{name: 'Not A Name', description: 'x', text: 'y'}];
  const handler = fixture(taskSkills('study', broken), false);
  const {result} = await call(handler, 'tools/call', {
    name: 'fixture',
    arguments: {},
  });
  assert.equal(result.content[0].text, 'ok');
  assert.ok(logged.length > 0);
  const record = JSON.parse(logged[0]);
  assert.equal(record.code, 'skills_unavailable');
  assert.equal(record.stage, 'skills');
  await handler.close();
});
