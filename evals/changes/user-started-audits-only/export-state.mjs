// Export a synthetic interruption boundary before hourly maintenance. No network.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdtempSync,chmodSync} from 'node:fs';
import {createSnapshotStore} from '../../../backend/snapshot-store.mjs';

const now=Date.UTC(2026,10,20,12),day=86400000;
const expired='11111111-1111-4111-8111-111111111111',ready='22222222-2222-4222-8222-222222222222';
const dir=mkdtempSync('/private/tmp/aeo-maintenance-export-'),dbPath=dir+'/state.sqlite',objectsPath=dir+'/objects.json';
const sql=new DatabaseSync(dbPath);sql.exec(readFileSync(new URL('../../../backend/schema.sql',import.meta.url),'utf8'));
const db={prepare(q){return{bind(...p){const s=sql.prepare(q);return{first:async()=>s.get(...p)??null,all:async()=>({results:s.all(...p)}),run:async()=>({meta:{changes:Number(s.run(...p).changes)}})};}};}};
let clock=now;const objects=new Map(),allowance={reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>({accepted:true})};
const bucket={put:async(k,v)=>objects.set(k,Buffer.from(v)),get:async()=>{throw Error('No read expected');},delete:async keys=>{for(const k of keys)objects.delete(k);}};
const snapshots=createSnapshotStore({db,bucket,allowance,now:()=>clock});
for(const[id,created]of[[expired,now-day],[ready,now-day+1]]) {
 clock=created;
 sql.prepare("INSERT INTO audits(id,url,cache_key,status,created_at,expires_at) VALUES(?,?,?,'pending',?,?)").run(id,'https://example.test/item',id,created,created+day);
 await snapshots.preserve({auditId:id,snapshot:{url:'https://example.test/item',retrievalMethod:'browser_api_content'},extracted:{},rawHtml:'<main>Fixture</main>'});
 sql.prepare("UPDATE retained_snapshots SET prepared_state='ready',prepared_hash=? WHERE audit_id=?").run('a'.repeat(64),id);
 sql.prepare("INSERT INTO browser_audit_work VALUES(?,'ready',?,?)").run(id,created,created+day);
 sql.prepare("INSERT INTO prepared_assessment_jobs(audit_id,prepared_hash,policy_version,state,updated_at,expires_at) VALUES(?,?,?,'waiting',?,?)").run(id,'a'.repeat(64),'prepared-assessment-v3',created,created+day);
 sql.prepare("INSERT INTO prepared_assessment_checkpoints VALUES(?,?,?,'0001',?,'fixture','completed','{}',NULL,?,?)").run(id,'a'.repeat(64),'prepared-assessment-v3','b'.repeat(64),created,created+day);
 sql.prepare("INSERT INTO audit_pipeline_state VALUES(?,'retained-ai-1','[]',?,?)").run(id,created,created+day);
}
sql.close();writeFileSync(objectsPath,JSON.stringify([...objects].map(([k,v])=>[k,v.toString('base64')])));chmodSync(dbPath,0o600);chmodSync(objectsPath,0o600);
const info={version:1,task:'Run cleanup without automatic audit recovery',interruptionPoint:'Before hourly maintenance, with an expired retained page and an unexpired ready audit waiting for recovery',dbPath,objectsPath,now,expiredAudit:expired,readyAudit:ready,sourceFiles:['backend/service.mjs','backend/snapshot-store.mjs','backend/prepared-assessment-jobs.mjs','backend/schema.sql'],instructions:['Use only this export and clean task source files. Do not read previous conversation, handoffs or reviews.','Copy SQLite to a private temporary directory. Restore saved R2 objects in a Map. No network/model/browser calls or implementation edits.','Run actual runScheduledMaintenance with actual createSnapshotStore and injected allowance and watchdog adapter. Add counters for any AUDIT_SELF access, RPC, model call and R2 page read; all must be zero.','Verify expired page objects and snapshot/work/pipeline/checkpoint/job rows deleted; unexpired ready waiting audit/objects remain unchanged; cleanup reserves500D1writes before deletion, watchdog remains guarded. Then deny allowance and verify no work or deletion.','Write genuine-continuation.mjs and concise exit-result.json here with version1,changeId user-started-audits-only,kind fresh-agent,priorConversationProvided false,agentId,status passed,observedContinuation string,limitations string and actual observations. Primary agent binds final sourceDigest/exportSha256. Remove temporary database copies.']};
writeFileSync(new URL('./exit-export.json',import.meta.url),JSON.stringify(info,null,2)+'\n');console.log(JSON.stringify({exported:true,objects:objects.size}));
