import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createValidationHandler, knownResponseRunner } from './runtime-worker.mjs';
import { assessRetainedRubric, restoreRubricAssessment } from '../../../backend/ai-rubric-assessment.mjs';
import { scoreAudit } from '../../../backend/scoring.mjs';

if (!crypto.subtle.timingSafeEqual) crypto.subtle.timingSafeEqual = (a,b) => Buffer.from(a).equals(Buffer.from(b));
const secret = 'x'.repeat(32), env = { AUDIT_VALIDATION_SECRET: secret, AUDIT_VALIDATION_RUN_ID: 'abcdefghijklmnop', AUDIT_VALIDATION_EXPIRES_AT: String(Date.now()+2700000) };
const req = (body, token = secret) => new Request('https://example.test/validate', {method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)});
test('authentication and case limits precede admission; duplicate is denied', async () => {
  let reservations=0;
  const handle=createValidationHandler({dependencies:()=>({allowance:{reserve:async()=>{reservations++; return {accepted:true,duplicate:true};}}})});
  assert.equal((await handle(req({caseId:'native-known'},'wrong'),env)).status,401);
  assert.equal((await handle(req({caseId:'invalid'}),env)).status,400);
  assert.equal(reservations,0);
  assert.equal((await handle(req({caseId:'native-known'}),env)).status,429);
  assert.equal(reservations,1);
});
test('known responses run the actual engine and reject changed retained inputs on replay', async () => {
  const snapshot={url:'https://fixture.example/products/shorts',rawHtml:'<html><h1>Everyday Shorts</h1></html>',observedAt:'fixed'};
  const extracted={coverage:{usable:true},productHtml:{blocks:[]}};
  const allowance={reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>({accepted:true})};
  const result=await assessRetainedRubric({AI:knownResponseRunner(),allowance,snapshot,extracted,report:scoreAudit(snapshot,extracted),calibrationApproved:true});
  assert.equal(result.status,'assessed');
  const restored=await restoreRubricAssessment(snapshot,extracted,result.replayArtifact);
  assert.deepEqual(restored,result.assessment);
  await assert.rejects(restoreRubricAssessment({...snapshot,observedAt:'changed'},extracted,result.replayArtifact));
});
test('raw retained input reaches assessment despite unusable legacy extraction', async () => {
  let retained, assessed = false, preOptions;
  const allowance = {reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>({accepted:true})};
  const snapshot = {url:'https://fixture.example/products/shorts',rawHtml:new TextEncoder().encode('<h1>Everyday Shorts</h1>'),extracted:{coverage:{usable:false}}};
  const snapshots = {
    async preserve({snapshot,extracted,rawHtml}) { const {rawHtml:ignored,extracted:ignored2,body:ignored3,...metadata}=snapshot; retained={snapshot:metadata,extracted,rawHtml}; return {}; },
    async read() { return retained; },
  };
  const handle = createValidationHandler({dependencies:()=>({allowance,snapshots,AI:{run:async()=>{throw Error('unexpected');}},retrieve:async()=>snapshot,extract:async()=>snapshot.extracted,score:(_s,_e,options)=>{preOptions=options;return {coverage:{limitations:[]}};},assess:async({snapshot:input})=>{assessed=input.rawHtml instanceof Uint8Array; return {status:'unavailable',reason:'test'};}})});
  const result=await handle(req({caseId:'synthetic'}),env);
  assert.equal(result.status,200);
  assert.equal(assessed,true);
  assert.deepEqual(preOptions,{requireAiAssessment:true});
  assert.equal((await result.json()).ai.status,'unavailable');
});

test('missing, expired and excessive expiry reject before any dependency work', async () => {
  let calls=0;
  const handle=createValidationHandler({dependencies:()=>{calls++; throw Error('unexpected');}});
  for (const expiry of [undefined, String(Date.now()-1), String(Date.now()+3601000), 'invalid']) {
    assert.equal((await handle(req({caseId:'synthetic'}),{...env,AUDIT_VALIDATION_EXPIRES_AT:expiry})).status,404);
  }
  assert.equal(calls,0);
});
