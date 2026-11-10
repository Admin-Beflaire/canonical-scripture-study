import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubActions, GitHubError } from '../../services/maintenance/control/src/github.ts';
import { canonicalJson } from '../../services/maintenance/control/src/d1.ts';
import type { JobInput } from '../../services/maintenance/control/src/contracts.ts';
import { fakeGitHub } from './github.ts';

const job = { contract_version: 'maintenance-job/1', task_id: 't', task_revision: 1, unit_id: 'u', attempt: 1, kind: 'prepare',
  basis_digest: 'a'.repeat(64), input_refs: [], manifest_revision: 'm', recipe_revision: 'r', native_extent: { b: 1, a: 2 },
  required_capabilities: [], dependency_refs: [], checkpoint_ref: null, constraints: {} } as unknown as JobInput;

test('dispatch sends only the canonical job to prepare.yml on main and returns the run', async () => {
  const gh = fakeGitHub();
  const actions = new GitHubActions({ repository: 'owner/app', token: 'synthetic-token' }, gh.fetcher);
  assert.deepEqual(await actions.dispatch(job), { run_id: '1000' });
  const [sent] = gh.requests;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, 'https://api.github.com/repos/owner/app/actions/workflows/prepare.yml/dispatches');
  assert.deepEqual(sent.body, { ref: 'main', inputs: { job: canonicalJson(job) }, return_run_details: true });
  assert.equal(sent.headers.authorization, 'Bearer synthetic-token');
  assert.ok(!sent.url.includes('synthetic-token'));
});

test('run identity must be a main-branch dispatch of the preparation workflow', async () => {
  const gh = fakeGitHub();
  const actions = new GitHubActions({ repository: 'owner/app', token: 't' }, gh.fetcher);
  const { run_id } = await actions.dispatch(job);
  assert.equal((await actions.run(run_id)).head_sha, gh.commit);
  for (const change of [{ path: '.github/workflows/deploy.yml' }, { event: 'push' }, { head_branch: 'feature' }, { head_sha: 'main' }]) {
    Object.assign(gh.runs.get(Number(run_id))!, { path: '.github/workflows/prepare.yml', event: 'workflow_dispatch', head_branch: 'main', head_sha: gh.commit }, change);
    await assert.rejects(actions.run(run_id), GitHubError);
  }
  await assert.rejects(actions.run('../1'), GitHubError);
  await assert.rejects(actions.run('999999'), GitHubError);
});

test('active runs, cancellation, recipes and refusals', async () => {
  const gh = fakeGitHub({ recipes: { 'collection/recipes/r.json': { id: 'r' } } });
  const actions = new GitHubActions({ repository: 'owner/app', token: 't' }, gh.fetcher);
  const a = (await actions.dispatch(job)).run_id;
  const b = (await actions.dispatch(job)).run_id;
  assert.deepEqual(new Set(await actions.activeRunIds()), new Set([a, b]));
  assert.equal(await actions.cancel(a), true);
  assert.equal(await actions.cancel(a), false);
  assert.deepEqual(await actions.activeRunIds(), [b]);
  assert.equal(await actions.readFile('collection/recipes/r.json'), '{"id":"r"}');
  assert.equal(await actions.readFile('collection/recipes/missing.json'), null);
  await assert.rejects(actions.readFile('.github/workflows/prepare.yml'), GitHubError);
  gh.state.failDispatch = true;
  await assert.rejects(actions.dispatch(job), GitHubError);
  assert.throws(() => new GitHubActions({ repository: 'owner/app/x', token: 't' }, gh.fetcher));
  assert.throws(() => new GitHubActions({ repository: 'owner/app', token: '' }, gh.fetcher));
});
