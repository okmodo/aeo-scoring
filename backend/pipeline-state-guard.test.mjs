import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createPipelineState} from './pipeline-state.mjs';

test('queue diagnostics reject stale owners, sequences, leases, and stale histories', async t => {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec(`CREATE TABLE audit_queue_jobs(audit_id TEXT PRIMARY KEY, owner TEXT, sequence INTEGER, state TEXT, lease_until INTEGER);
    CREATE TABLE audit_pipeline_state(audit_id TEXT PRIMARY KEY, version TEXT, state_json TEXT, updated_at INTEGER, expires_at INTEGER);
    INSERT INTO audit_queue_jobs VALUES ('audit','owner-a',1,'running',100);`);
  const db = {prepare(query) { return {bind(...params) {
    const statement = sql.prepare(query);
    const args = [Object.fromEntries(params.map((value,index)=>[String(index+1),value]))];
    return {first:async()=>statement.get(...args) ?? null,run:async()=>({meta:{changes:Number(statement.run(...args).changes)}})};
  }}; }};
  const state = () => createPipelineState({db,auditId:'audit',now:()=>10});
  const original=state();
  await original.record('retrieval','running','browser_loading',{owner:'owner-a',sequence:1,state:'running'});
  const stale=state(), newer=state();
  await stale.load(); await newer.load();
  await newer.record('preparation','running','preparation_started',{owner:'owner-a',sequence:1,state:'running'});
  const saved=sql.prepare('SELECT state_json FROM audit_pipeline_state').get().state_json;
  await stale.record('content','running','facts_preparing',{owner:'owner-a',sequence:1,state:'running'});
  assert.equal(sql.prepare('SELECT state_json FROM audit_pipeline_state').get().state_json,saved);
  assert.equal(stale.summary().stages.length,1);
  sql.prepare("UPDATE audit_queue_jobs SET owner='owner-b', sequence=2").run();
  const oldOwner=state(); await oldOwner.load();
  await oldOwner.record('content','running','facts_preparing',{owner:'owner-a',sequence:1,state:'running'});
  await oldOwner.record('content','running','facts_preparing',{owner:'owner-b',sequence:1,state:'running'});
  assert.equal(sql.prepare('SELECT state_json FROM audit_pipeline_state').get().state_json,saved);
  sql.prepare('UPDATE audit_queue_jobs SET lease_until=10').run();
  await oldOwner.record('content','running','facts_preparing',{owner:'owner-b',sequence:2,state:'running'});
  assert.equal(sql.prepare('SELECT state_json FROM audit_pipeline_state').get().state_json,saved);
});
