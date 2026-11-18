import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createAuditService } from './service.mjs';
import { createSnapshotStore } from './snapshot-store.mjs';

const id = 'd9428888-122b-4c77-8d11-666666666666';
const now = Date.UTC(2026, 10, 17), url = 'https://example.test/product';
const html = '<h1>Climbing belay device</h1><p>A friction brake for rope climbing.</p>';
function fixture({ failSnapshot = false, failFacts = false, limited = false, enabled = true, assessor } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0003-retained-snapshots.sql', '0005-pipeline-state.sql']) sqlite.exec(readFileSync(new URL('./migrations/' + name, import.meta.url), 'utf8'));
  const db = { prepare(sql) { return { bind(...args) { const stmt = sqlite.prepare(sql); return { first:async()=>stmt.get(...args)??null, all:async()=>({results:stmt.all(...args)}), run:async()=>({meta:{changes:Number(stmt.run(...args).changes)}}) }; } }; } };
  const objects = new Map(), events = [];
  const allowance = {reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>({accepted:true})};
  const bucket = {put:async(key,bytes)=>{ if (failSnapshot && !key.endsWith('/profile') && !key.endsWith('/facts') || failFacts && key.endsWith('/facts')) throw Error('private storage error'); objects.set(key,bytes); },get:async key=>{const value=objects.get(key); return value ? {size:value.length,body:new Response(value).body}:null;},delete:async keys=>keys.forEach(k=>objects.delete(k))};
  const snapshots = createSnapshotStore({db,bucket,allowance,now:()=>now});
  let audit = {id,url,status:'pending',createdAt:now,expiresAt:now+86400000}, task, key;
  const handle = createAuditService({normalizeUrl:value=>value,store:{reserve:async input=>{key=input.cacheKey; return {kind:'created',audit};},finish:async(_id,result)=>{audit={...audit,...result};}},allowance,snapshotStore:snapshots,pipelineDb:db,requireSnapshots:true,openRubricEnabled:enabled,
    AI:{run:()=>assert.fail('injected assessor owns model')},HTMLRewriter:class{},egress:{fetch:()=>assert.fail('injected retrieval')},secret:'x'.repeat(32),now:()=>now,
    retrievePage:async(_url,options)=>{assert.equal(options.captureHtml,true); return {url,htmlLimited:limited?'bytes':null,extracted:{coverage:{usable:true},jsonLd:[]},rawHtml:new TextEncoder().encode(html)};},
    scorePage:(snapshot,_extracted,options)=>{events.push(options?'final-score':'initial-score'); if(options) { assert.equal(sqlite.prepare('SELECT facts_state FROM retained_snapshots').get().facts_state,'ready'); assert.deepEqual(options,{aiAssessment:{test:true}}); } return {status:snapshot.htmlLimited?'incomplete':'complete',score:snapshot.htmlLimited?null:{total:77},coverage:{notMeasured:0,limitations:[]}};},
    assessRubric:assessor || (async()=>({status:'unavailable',reason:'Not assessed.'})) });
  return {sqlite,snapshots,events,get audit(){return audit;},get key(){return key;},async run(){const response=await handle(new Request('https://audit.test/api/v1/audits',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})}),{address:'192.0.2.1',defer:p=>{task=p;}});assert.equal(response.status,202);await task;}};
}

test('open assessment receives retained raw HTML without a recognized product region and persists profile and artifact before scoring',async()=>{
  const profile={version:'1',category:'Belay devices'}, artifact={version:'1',judgments:[]};
  const f=fixture({assessor:async args=>{
    assert.equal(new TextDecoder().decode(args.snapshot.rawHtml),html); assert.equal(args.extracted.productHtml,undefined);
    await args.onProfile(profile);
    assert.deepEqual(await f.snapshots.readAssessment(id,'profile'),profile);
    assert.equal(f.sqlite.prepare('SELECT facts_state FROM retained_snapshots').get().facts_state,null);
    return {status:'assessed',assessment:{test:true},replayArtifact:artifact,stages:[]};
  }});
  await f.run(); assert.deepEqual(await f.snapshots.readAssessment(id),artifact); assert.deepEqual(f.events,['initial-score','final-score']); assert.equal(f.audit.status,'complete'); f.sqlite.close();
});

test('storage failures stop model work or prevent scoring an unretained assessment',async()=>{
  let called=false;
  const first=fixture({failSnapshot:true,assessor:async()=>{called=true;}}); await first.run(); assert.equal(called,false); assert.equal(first.audit.status,'incomplete'); assert.equal(first.audit.report.score,null); first.sqlite.close();
  const second=fixture({failFacts:true,assessor:async args=>{await args.onProfile({version:'1',category:'Belay devices'});return {status:'assessed',assessment:{test:true},replayArtifact:{version:'1'},stages:[]};}});
  await second.run(); assert.deepEqual(second.events,['initial-score']); assert.equal(second.audit.status,'incomplete'); assert.equal(second.audit.report.score,null); assert.doesNotMatch(JSON.stringify(second.audit.report),/private storage error/); second.sqlite.close();
});

test('limited input stays incomplete and open release has a distinct cache identity',async()=>{
  const partial=fixture({limited:true,assessor:async args=>{await args.onProfile({version:'1',category:'Belay devices'});return {status:'assessed',assessment:{test:true},replayArtifact:{version:'1'},stages:[]};}});
  await partial.run(); assert.equal(partial.audit.status,'incomplete'); assert.equal(partial.audit.report.score,null);
  const disabled=fixture({enabled:false}); await disabled.run(); assert.notEqual(partial.key,disabled.key); partial.sqlite.close(); disabled.sqlite.close();
});
