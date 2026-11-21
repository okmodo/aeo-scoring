import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { runScheduledMaintenance } from '../../../backend/service.mjs';
import { createSnapshotStore } from '../../../backend/snapshot-store.mjs';
const dir=dirname(fileURLToPath(import.meta.url));
const x=JSON.parse(readFileSync(join(dir,'exit-export.json')));
const temp=mkdtempSync(join(tmpdir(),'aeo-fresh-'));
const tables=['retained_snapshots','browser_audit_work','audit_pipeline_state','prepared_assessment_checkpoints','prepared_assessment_jobs'];
const objects=JSON.parse(readFileSync(x.objectsPath));
let counters={self:0,rpc:0,model:0,pageReads:0};
const forbidden=()=>{throw Error('forbidden external call');};
async function scenario(denied) {
  const path=join(temp,`${denied || 'allowed'}.sqlite`); copyFileSync(x.dbPath,path);
  const sql=new DatabaseSync(path);
  const events=[];
  const db={prepare(query){return {bind(...args){return {
    async all(){return {results:sql.prepare(query).all(...args)}},
    async first(){return sql.prepare(query).get(...args) ?? null},
    async run(){events.push('sql-write'); return {meta:{changes:Number(sql.prepare(query).run(...args).changes)}}}
  }}}}};
  const map=new Map(objects.map(([k,v])=>[k,v]));
  const bucket={put:forbidden,get(){counters.pageReads++; return forbidden()},async delete(keys){events.push('object-delete'); for(const k of keys) map.delete(k)}};
  const snapshot=()=>Object.fromEntries(tables.map(t=>[t,sql.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  const before=snapshot(), beforeObjects=[...map];
  const allowance={async reserve({id,costs}){const type=id.startsWith('browser-watchdog-')?'watchdog':'cleanup'; events.push(`reserve-${type}-${costs.d1Writes}`); return {accepted:denied!==type,duplicate:false}},async settle({id}){events.push(id.startsWith('browser-watchdog-')?'settle-watchdog':'settle-cleanup'); return {accepted:true}}};
  const env={AUDIT_DB:db,AUDIT_USAGE_READ_TOKEN:'fixture',AUDIT_BROWSER:{},AUDIT_SNAPSHOTS:bucket,AI:{run(){counters.model++; return forbidden()}}};
  Object.defineProperty(env,'AUDIT_SELF',{get(){counters.self++; return {fetch(){counters.rpc++; return forbidden()}}}});
  await runScheduledMaintenance({scheduledTime:x.now},env,{now:x.now,allowance,makeWorkflow:()=>({async watchdog(){events.push('watchdog')}}),makeSnapshots:({db,bucket,allowance})=>createSnapshotStore({db,bucket,allowance,now:()=>x.now})});
  const after=snapshot();
  if(denied){assert.deepEqual(after,before);assert.deepEqual([...map],beforeObjects);assert(!events.includes('object-delete'));assert(!events.includes('sql-write'));if(denied==='watchdog') assert(!events.includes('watchdog')); else assert(events.includes('watchdog'));}
  else {
    assert(events.indexOf('reserve-watchdog-100')<events.indexOf('watchdog'));
    assert(events.indexOf('watchdog')<events.indexOf('reserve-cleanup-500'));
    assert(events.indexOf('reserve-cleanup-500')<events.indexOf('object-delete'));
    for(const table of tables){assert(before[table].some(r=>r.audit_id===x.expiredAudit),`${table} missing expired fixture`);assert(!after[table].some(r=>r.audit_id===x.expiredAudit),`${table} expired remains`);assert.deepEqual(after[table].filter(r=>r.audit_id===x.readyAudit),before[table].filter(r=>r.audit_id===x.readyAudit));}
    assert(beforeObjects.some(([k])=>k.includes(x.expiredAudit)));assert(![...map.keys()].some(k=>k.includes(x.expiredAudit)));assert.deepEqual([...map].filter(([k])=>k.includes(x.readyAudit)),beforeObjects.filter(([k])=>k.includes(x.readyAudit)));
  }
  sql.close(); return {events,remainingObjects:map.size};
}
try {
 const allowed=await scenario(null), deniedWatchdog=await scenario('watchdog'),deniedCleanup=await scenario('cleanup');
 assert.deepEqual(counters,{self:0,rpc:0,model:0,pageReads:0});
 const result={version:1,changeId:'user-started-audits-only',kind:'fresh-agent',priorConversationProvided:false,agentId:'user_only_fresh_exit',status:'passed',observedContinuation:`Allowed: ${allowed.events.join(', ')}; expired rows in all five tables and expired objects deleted, ready audit rows and objects unchanged. Denied watchdog: ${deniedWatchdog.events.join(', ')}; denied cleanup: ${deniedCleanup.events.join(', ')}; both left database and objects unchanged. AUDIT_SELF accesses, RPC, model calls, and page reads: 0.`,limitations:'Offline fixture with private SQLite copy, in-memory R2 and injected allowance/watchdog adapters; no live services or browser calls.'};
 writeFileSync(join(dir,'exit-result.json'),JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result));
} finally {rmSync(temp,{recursive:true,force:true})}
