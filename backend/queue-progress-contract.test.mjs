import test from 'node:test';
import assert from 'node:assert/strict';
import {auditProgress} from '../contracts/progress.mjs';

const project = (records, extra={}) => auditProgress({auditId:'audit',queue:{sequence:2,phase:'assess'},pipeline:JSON.stringify(records),prepared:'ready',status:'pending',report:null,...extra});
const event = (stage,status) => ({stage,status,code:'private_diagnostic',at:1});
test('progress only completes scoring after a report is published',()=>{
  const records=[event('retrieval','running'),event('retrieval','completed'),event('content','running'),event('scoring','running'),event('scoring','completed')];
  const pending=project(records);
  assert.deepEqual(pending.events.filter(x=>x.stage==='scoring').map(x=>x.status),['running']);
  const published=project(records,{status:'complete',report:{}});
  assert.deepEqual(published.events.filter(x=>x.stage==='scoring').map(x=>x.status),['running','completed']);
  assert.ok(published.revision>pending.revision);
  assert.doesNotMatch(JSON.stringify(published),/private_diagnostic/);
});
test('readiness recovers preparation and failures remain visible',()=>{
  const partial=project([event('content','failed')],{status:'incomplete',report:{}});
  assert.deepEqual(partial.events.filter(x=>x.stage==='preparation').map(x=>x.status),['running','completed']);
  assert.ok(partial.events.some(x=>x.stage==='assessment'&&x.status==='failed'));
  const failed=project([],{queue:{sequence:0,phase:'capture'},prepared:null,status:'unable_to_assess'});
  assert.ok(failed.events.some(x=>x.stage==='retrieval'&&x.status==='failed'));
  assert.equal(auditProgress({queue:null}),undefined);
});
test('repeated deliveries do not duplicate events or change revision',()=>{
  const records=[event('content','running'),event('content','running')];
  const first=project(records), second=project(records);
  assert.deepEqual(first,second);
  assert.equal(first.events.filter(x=>x.stage==='assessment'&&x.status==='running').length,1);
});

test('latest retained outcome replaces an earlier failure after recovery',()=>{
  const records=[event('content','running'),event('content','failed'),event('content','completed')];
  const progress=project(records);
  assert.deepEqual(progress.events.filter(x=>x.stage==='assessment').map(x=>x.status),['running','completed']);
  assert.ok(progress.events.every(x=>x.stage!=='scoring'||x.status!=='completed'));
});

test('incomplete publication preserves explicit skipped and failed outcomes',()=>{
  for (const outcome of ['skipped','failed']) {
    const progress=project([event('content','running'),event('content',outcome)],{status:'incomplete',report:{}});
    assert.deepEqual(progress.events.filter(x=>x.stage==='assessment').map(x=>x.status),['running',outcome]);
    assert.ok(progress.events.some(x=>x.stage==='scoring'&&x.status==='completed'));
  }
});
