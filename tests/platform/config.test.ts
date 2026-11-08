import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { renderWorkerConfigs } from '../../infrastructure/cloudflare/render.mjs';
const root = resolve(import.meta.dirname,'../..');
import input from "./instance.fixture.json" with { type: "json" };

test('one template renders two independent instance/binding sets', () => {
  const first = renderWorkerConfigs(input, root);
  const second = renderWorkerConfigs({...input,ACCOUNT_ID:'d'.repeat(32),ZONE_ID:'e'.repeat(32),ZONE_NAME:'second.invalid',INSTANCE:'fixture-b',STUDY_HOSTNAME:'s.second.invalid',CONTROL_HOSTNAME:'c.second.invalid',DATABASE_ID:'22222222-2222-4222-8222-222222222222',ACCESS_ISSUER:'https://second.cloudflareaccess.com',STUDY_AUDIENCE:'d'.repeat(64),CONTROL_AUDIENCE:'e'.repeat(64),JOB_AUDIENCE:'f'.repeat(64)},root);
  assert.notDeepEqual(first,second);
  for (const config of [first,second]) {
    for (const role of ['study','control']) {
      assert.equal(config[role].workers_dev,false);
      assert.equal(config[role].preview_urls,false);
      assert.equal(config[role].routes[0].custom_domain,true);
      assert.equal(config[role].d1_databases[0].binding,'DATA_DB');
      assert.equal(config[role].r2_buckets[0].binding,'PRIVATE_OBJECTS');
      assert.equal(config[role].vars.ENHANCEMENTS,false);
      assert.equal(config[role].vars.DEPLOYMENT_CLIENT_ID,input.DEPLOYMENT_CLIENT_ID);
      assert.doesNotMatch(JSON.stringify(config[role]),/\{\{/);
    }
    assert.equal(config.study.vars.JOB_AUDIENCE,undefined);
    assert.notEqual(config.control.vars.HOST_AUDIENCE,config.control.vars.JOB_AUDIENCE);
  }
});
test('missing, injected, reused and oversized settings fail before rendering', () => {
  for (const key of Object.keys(input)) {
    const copy: Record<string,unknown> = {...input}; delete copy[key];
    const message = key === 'ENHANCEMENTS' ? 'Explicit ENHANCEMENTS boolean required' : `Invalid or missing ${key}`;
    assert.throws(()=>renderWorkerConfigs(copy,root),{message});
  }
  assert.throws(()=>renderWorkerConfigs({...input,INSTANCE:'{{missing}}'},root),/Invalid or missing INSTANCE/);
  for (const extra of [{STUDY_HOSTNAME:input.CONTROL_HOSTNAME},{STUDY_HOSTNAME:'evil.workers.dev'},{STUDY_AUDIENCE:input.JOB_AUDIENCE},{REQUEST_BYTES:1},{MAX_D1_CALLS:51},{CPU_BUDGET_MS:11},{CLOUDFLARE_API_TOKEN:'never-render'}]) assert.throws(()=>renderWorkerConfigs({...input,...extra},root));
});
test('no competing Worker or SQL writer in Terraform; R2 managed access disabled',()=>{
  const directory = resolve(root,'infrastructure/cloudflare');
  const terraform = readdirSync(directory).filter(name=>name.endsWith('.tf')).map(name=>readFileSync(resolve(directory,name),'utf8')).join('\n');
  assert.doesNotMatch(terraform,/resource "cloudflare_workers|resource "cloudflare_dns|local-exec/);
  assert.match(terraform,/resource "cloudflare_r2_managed_domain"[\s\S]*?enabled\s+= false/);
  assert.match(terraform,/\/internal\/jobs\/\*/);
  assert.match(terraform,/resource "cloudflare_zero_trust_access_policy" "deployment_check"/);
  assert.match(terraform,/resource "cloudflare_zero_trust_access_policy" "study_owner"/);
  assert.match(terraform,/each\.key == "study" \? cloudflare_zero_trust_access_policy\.study_owner\.id : cloudflare_zero_trust_access_policy\.owner\.id/);
});

test('malformed DNS labels and trailing instance hyphens fail validation',()=>{
  for (const key of ['ZONE_NAME','STUDY_HOSTNAME','CONTROL_HOSTNAME']) {
    for (const value of ['a..example.invalid','-a.example.invalid','a-.example.invalid','a'.repeat(64)+'.example.invalid',('a'.repeat(60)+'.').repeat(5)+'invalid']) {
      assert.throws(()=>renderWorkerConfigs({...input,[key]:value},root),{message:`Invalid or missing ${key}`});
    }
  }
  assert.throws(()=>renderWorkerConfigs({...input,INSTANCE:'a-'},root),/Invalid or missing INSTANCE/);
});
test('re-rendering resets stale directory and file permissions', {skip:process.platform==='win32'},()=>{
  const directory=resolve(root,'dist/config');
  mkdirSync(directory,{recursive:true});
  chmodSync(directory,0o755);
  for (const role of ['study','control']) {
    const path=resolve(directory,`${role}.json`);
    writeFileSync(path,'{}'); chmodSync(path,0o644);
  }
  execFileSync(process.execPath,['infrastructure/cloudflare/render.mjs','tests/platform/instance.fixture.json'],{cwd:root});
  assert.equal(statSync(directory).mode & 0o777,0o700);
  for (const role of ['study','control']) assert.equal(statSync(resolve(directory,`${role}.json`)).mode & 0o777,0o600);
});
