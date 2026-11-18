// Engine 2.2 isolates cached reports for the new rubric-assessment path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createAuditService } from './service.mjs';
import { createSnapshotStore } from './snapshot-store.mjs';
import { scoreAudit } from './scoring.mjs';
import { validateCategoryResponse, validateProfileResponse } from './category-profile.mjs';
import { buildSemanticRequest } from './semantic-assessment.mjs';
const id = 'd9428888-122b-4c77-8d11-666666666666';
const now = Date.UTC(2026, 10, 17), url = 'https://example.test/shorts';
const input = { url, observedAt: new Date(now).toISOString(), extracted: {coverage:{usable:true},productHtml:{identity:'Acme Hiking Shorts',complete:true,blocks:[{text:'Inseam: 8 inches',location:'details'}],links:[]},jsonLd:[]}, rawHtml:new TextEncoder().encode('<h1>Acme Hiking Shorts</h1>') };
function fixture({ failStorage = false, failProfile = false, assessContent } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0003-retained-snapshots.sql','0005-pipeline-state.sql']) sqlite.exec(readFileSync(new URL('./migrations/' + name, import.meta.url), 'utf8'));
  const db = { prepare(sql) { return { bind(...args) { const stmt = sqlite.prepare(sql); return { first:async()=>stmt.get(...args)??null, all:async()=>({results:stmt.all(...args)}), run:async()=>({meta:{changes:Number(stmt.run(...args).changes)}}) }; } }; } };
  const objects = new Map(); let downloaded = 0, reads = 0, task, audit = {id,url,status:'pending',createdAt:now,expiresAt:now+86400000};
  const allowance = {reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>({accepted:true})};
  const bucket = {put:async(key,bytes)=>{if(failStorage || failProfile && key.endsWith('/profile'))throw Error('private provider error');objects.set(key,bytes);},get:async key=>{reads++;const value=objects.get(key);return value ? {size:value.length,body:new Response(value).body}:null;},delete:async keys=>keys.forEach(k=>objects.delete(k))};
  const snapshots = createSnapshotStore({db,bucket,allowance,now:()=>now});
  const handle = createAuditService({normalizeUrl:value=>value,store:{reserve:async()=>({kind:'created',audit}),finish:async(_id,result)=>{audit={...audit,...result};}},allowance,snapshotStore:snapshots,pipelineDb:db,requireSnapshots:true,AI:{run:()=>assert.fail('stub assessor owns model')},HTMLRewriter:class{},egress:{fetch:()=>assert.fail('injected retrieval')},secret:'x'.repeat(32),now:()=>now,
    retrievePage:async(_url,options)=>{downloaded++;assert.equal(options.captureHtml,true);return structuredClone(input);},
    scorePage:()=>({status:'incomplete',score:null,coverage:{notMeasured:1,limitations:[]}}),contentCalibrationApproved:true,assessContent});
  return {sqlite,get audit(){return audit;},get downloaded(){return downloaded;},get reads(){return reads;},snapshots,async run(){const response=await handle(new Request('https://audit.test/api/v1/audits',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})}),{address:'192.0.2.1',defer:p=>{task=p;}});assert.equal(response.status,202);await task;}};
}
test('assessment consumes the stored verified extraction after one download and persists stage outcomes',async()=>{
  let calls=0;
  const f=fixture({assessContent:async args=>{calls++;assert.deepEqual(args.extracted,input.extracted);assert.equal(args.snapshot.rawHtml,undefined);assert.equal(args.deadlineAt,now+25000);return {status:'unavailable',reason:'The product category was ambiguous.',stages:[{stage:'category',status:'failed',code:'ambiguous_category'},{stage:'content',status:'skipped',code:'category_unavailable'}]};}});
  await f.run();assert.equal(f.downloaded,1);assert.equal(f.reads,2);assert.equal(calls,1);assert.equal(f.audit.status,'incomplete');assert.equal(f.audit.report.score,null);
  const stages=f.audit.report.coverage.pipeline.stages;assert.deepEqual(stages.map(s=>s.code),['downloading','downloaded','snapshot_retained','classification_started','ambiguous_category','category_unavailable','report_incomplete']);
  assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT state_json FROM audit_pipeline_state').get().state_json),stages);f.sqlite.close();
});
test('failed snapshot storage stops before AI and retains a private safe diagnostic',async()=>{
  const f=fixture({failStorage:true,assessContent:()=>assert.fail('AI must not run')});await f.run();assert.equal(f.audit.status,'incomplete');assert.equal(f.audit.report.score,null);assert.equal(f.audit.report.coverage.pipeline.stages.at(-1).code,'snapshot_unavailable');assert.doesNotMatch(JSON.stringify(f.audit.report),/private provider error/);assert.equal(f.sqlite.prepare('SELECT state FROM retained_snapshots').get().state,'pending');f.sqlite.close();
});
test('validated open category reaches scoring without entering the fixed category registry',()=>{
  const p=buildSemanticRequest(input,input.extracted,{});
  const classification=validateCategoryResponse(p,{status:'classified',label:'Hiking Shorts',evidence:[{sourceId:'s1',quote:'Acme Hiking Shorts'}]});
  const profile=validateProfileResponse(classification,{essential:['Waist size','Inseam','Fabric composition'],supporting:['Care instructions','Pocket configuration','Closure type']});
  const report=scoreAudit(input,input.extracted,{categoryProfile:profile});
  assert.equal(report.category,'open:hiking-shorts');assert.equal(report.coverage.categoryAssessment.label,'Hiking Shorts');assert.equal(report.engineVersion,'2.2.1');assert.equal(report.score,null);
  const forged=scoreAudit(input,input.extracted,{categoryProfile:structuredClone(profile)});assert.equal(forged.coverage.categoryAssessment,undefined);
});

test('successful assessment retains frozen profile and replay facts before report completion',async()=>{
  const artifact={version:'1',categoryProfile:{id:'open:hiking-shorts'},originalOutput:{facts:[]}};
  const f=fixture({assessContent:async args=>{
    await args.onProfile(artifact.categoryProfile);
    const row=f.sqlite.prepare('SELECT profile_state, facts_state FROM retained_snapshots').get();
    assert.equal(row.profile_state,'ready');assert.equal(row.facts_state,null);
    return {status:'assessed',facts:{},categoryProfile:artifact.categoryProfile,replayArtifact:artifact,stages:[{stage:'category',status:'completed',code:'profile_validated'},{stage:'content',status:'completed',code:'facts_validated'}]};
  }});
  await f.run();assert.deepEqual(await f.snapshots.readAssessment(id),artifact);
  assert.deepEqual(await f.snapshots.readAssessment(id,'profile'),{version:'1',categoryProfile:artifact.categoryProfile});
  assert.equal(f.audit.report.coverage.pipeline.stages.at(-2).code,'assessment_retained');f.sqlite.close();
});

test('failed profile persistence never scores an unretained profile',async()=>{
  const f=fixture({failProfile:true,assessContent:async args=>{
    const categoryProfile={id:'open:hiking-shorts'};
    await assert.rejects(args.onProfile(categoryProfile));
    return {status:'unavailable',categoryProfile,reason:'The profile could not be retained.',stages:[{stage:'category',status:'completed',code:'profile_validated'},{stage:'content',status:'failed',code:'profile_persistence_failed'}]};
  }});
  await f.run();assert.equal(f.audit.status,'incomplete');assert.equal(f.audit.report.score,null);assert.equal(f.audit.report.category,undefined);
  assert.equal(f.audit.report.coverage.pipeline.stages.at(-2).code,'profile_persistence_failed');
  assert.equal(f.sqlite.prepare('SELECT profile_state FROM retained_snapshots').get().profile_state,'pending');f.sqlite.close();
});

test('scheduled cleanup reserves its bounded invocation before any deletion and retains unknown failures',async()=>{
  const {cleanupRetainedSnapshots}=await import('./service.mjs');
  for(const accepted of [false,true]) {
    const events=[];const allowance={reserve:async ({costs})=>{events.push('reserve');assert.equal(costs.cpuMs,2000);assert.equal(costs.d1Writes,200);return{accepted,duplicate:false};},settle:async()=>events.push('settle')};
    const snapshots={cleanup:async ({limit})=>{events.push('cleanup');assert.equal(limit,10);return{deleted:2};}};
    const db={prepare(sql){assert.match(sql,/LIMIT 100/);return{bind(at){assert.equal(at,now);return{run:async()=>events.push('diagnostics')};}};}};
    const result=await cleanupRetainedSnapshots({db,snapshots,allowance,now});
    assert.deepEqual(events,accepted?['reserve','cleanup','diagnostics','settle']:['reserve']);assert.equal(result.status,accepted?'completed':'skipped');
  }
  let settled=false;
  await assert.rejects(cleanupRetainedSnapshots({db:{},snapshots:{cleanup:async()=>{throw Error('delete unknown');}},allowance:{reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>{settled=true;}},now}));
  assert.equal(settled,false);
});
