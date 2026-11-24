import test from 'node:test';
import assert from 'node:assert/strict';
import {auditProgress} from '../contracts/progress.mjs';
const event=(stage,status,code)=>({stage,status,code,at:1});
const project=(records,extra={})=>auditProgress({auditId:'audit',queue:{sequence:2,phase:'assess'},pipeline:JSON.stringify(records),retained:'ready',work:'ready',prepared:'ready',status:'pending',report:null,checksCompletedAt:1,...extra});
const states=(p,stage)=>p.events.filter(x=>x.stage===stage).map(x=>x.status);
test('capture requires usable persisted state, not a provider reply or stored error page',()=>{
  const records=[event('retrieval','running','browser_loading'),event('retrieval','completed','browser_api_captured'),event('snapshot','completed','browser_content_stored')];
  assert.deepEqual(states(project(records,{retained:'ready',work:'capturing',prepared:null}),'retrieval'),['running']);
  assert.deepEqual(states(project(records,{retained:'ready',work:'ready',prepared:null}),'retrieval'),['running','completed']);
  assert.deepEqual(states(project(records,{retained:null,work:'ready',prepared:null}),'retrieval'),['running']);
});
test('readiness recovers preparation and markers reflect actual assessment and assembly',()=>{
  const records=[event('preparation','running','preparation_started'),event('content','running','facts_preparing'),event('content','completed','judgments_validated'),event('scoring','running','report_building'),event('scoring','completed','report_incomplete')];
  assert.deepEqual(states(project(records,{checksCompletedAt:null}),'scoring'),['running']);
  const p=project(records);assert.deepEqual(states(p,'preparation'),['running','completed']);assert.deepEqual(states(p,'assessment'),['running','completed']);assert.deepEqual(states(p,'scoring'),['running','completed']);
  assert.equal(p.events.some(x=>x.code),false);
});
test('latest outcome replaces a failure when validated judgments recover',()=>{
  const p=project([event('content','running','facts_preparing'),event('content','failed','timeout'),event('content','completed','judgments_recovered')]);
  assert.deepEqual(states(p,'assessment'),['running','completed']);
});
test('duplicate and unrecognized milestones are bounded and cannot claim success',()=>{
  const records=[event('content','running','facts_preparing'),event('content','running','facts_preparing'),event('retrieval','completed','browser_api_captured'),event('content','completed','model_reply')];
  const p=project(records,{retained:null,work:null,prepared:null});assert.deepEqual(states(p,'assessment'),['running']);assert.deepEqual(states(p,'retrieval'),[]);assert.deepEqual(p,project(records,{retained:null,work:null,prepared:null}));
  assert.equal(project(Array(17).fill(records[0])),undefined);assert.equal(auditProgress({queue:null}),undefined);
});
test('publication and reportless failure are authoritative, with advancing revisions',()=>{
  const records=[event('content','running','facts_preparing'),event('content','skipped','unavailable')];
  const pending=project(records), published=project(records,{status:'incomplete',report:{}});
  assert.deepEqual(states(published,'assessment'),['running','skipped']);assert.deepEqual(states(published,'scoring'),['running','completed']);assert.ok(published.revision>pending.revision);
  assert.deepEqual(states(project([],{queue:{sequence:0,phase:'capture'},retained:null,work:null,prepared:null,status:'unable_to_assess'}),'retrieval'),['failed']);
  assert.equal(project([],{pipeline:'not json'}),undefined);
});
