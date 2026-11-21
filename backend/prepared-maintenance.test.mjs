import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {runScheduledMaintenance} from './service.mjs';
import {createSnapshotStore} from './snapshot-store.mjs';

const now=Date.UTC(2026,10,20,12), day=86400000;
const expired='11111111-1111-4111-8111-111111111111';
const ready='22222222-2222-4222-8222-222222222222';

async function fixture() {
  const sql=new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  const db={prepare(q){return{bind(...args){const statement=sql.prepare(q);return{
    first:async()=>statement.get(...args)??null,
    all:async()=>({results:statement.all(...args)}),
    run:async()=>({meta:{changes:Number(statement.run(...args).changes)}}),
  };}};}};
  const objects=new Map(),deletes=[],events=[],reservations=[];
  let clock=now,allowed=true,dispatchReads=0;
  const allowance={reserve:async r=>{reservations.push(r);events.push('reserve');return{accepted:allowed,duplicate:false};},settle:async()=>{events.push('settle');return{accepted:true};}};
  const snapshots=createSnapshotStore({db,allowance,now:()=>clock,bucket:{
    put:async(k,v)=>objects.set(k,v),get:async()=>assert.fail('cleanup must not read page content'),
    delete:async keys=>{for(const key of keys){deletes.push(key);objects.delete(key);}},
  }});
  for(const [id,created] of [[expired,now-day],[ready,now-day+1]]) {
    clock=created;
    sql.prepare("INSERT INTO audits(id,url,cache_key,status,created_at,expires_at) VALUES(?,?,?,'pending',?,?)").run(id,'https://example.test/item',id,created,created+day);
    await snapshots.preserve({auditId:id,snapshot:{url:'https://example.test/item',retrievalMethod:'browser_api_content'},extracted:{},rawHtml:'<main>Fixture</main>'});
    sql.prepare("UPDATE retained_snapshots SET prepared_state='ready',prepared_hash=? WHERE audit_id=?").run('a'.repeat(64),id);
    sql.prepare("INSERT INTO browser_audit_work VALUES(?,'ready',?,?)").run(id,created,created+day);
    sql.prepare("INSERT INTO prepared_assessment_jobs(audit_id,prepared_hash,policy_version,state,updated_at,expires_at) VALUES(?,?,?,'waiting',?,?)").run(id,'a'.repeat(64),'prepared-assessment-v3',created,created+day);
    sql.prepare("INSERT INTO prepared_assessment_checkpoints VALUES(?,?,?,'0001',?,'fixture','completed','{}',NULL,?,?)").run(id,'a'.repeat(64),'prepared-assessment-v3','b'.repeat(64),created,created+day);
    sql.prepare("INSERT INTO audit_pipeline_state VALUES(?,'retained-ai-1','[]',?,?)").run(id,created,created+day);
  }
  clock=now;events.length=0;reservations.length=0;
  const env={AUDIT_DB:db,AUDIT_USAGE_READ_TOKEN:'offline',AUDIT_BROWSER:{},AUDIT_SNAPSHOTS:{},AUDIT_AI:{run:()=>events.push('model')}};
  Object.defineProperty(env,'AUDIT_SELF',{get(){dispatchReads++;return{prepare:async()=>events.push('prepare'),assess:async()=>events.push('assess')};}});
  const options={now,allowance,makeSnapshots:()=>snapshots,makeWorkflow:()=>({watchdog:async()=>events.push('watchdog')})};
  return{sql,env,options,objects,deletes,events,reservations,reads:()=>dispatchReads,deny:()=>{allowed=false;}};
}

test('hourly cleanup expires retained pages and job metadata without recovering ready audits',async()=>{
  const f=await fixture();
  try{
    await runScheduledMaintenance({scheduledTime:now},f.env,f.options);
    assert.deepEqual(f.events,['reserve','watchdog','settle','reserve','settle']);
    assert.equal(f.reads(),0);
    assert.equal(f.reservations[1].costs.d1Writes,500);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM retained_snapshots WHERE audit_id=?').get(expired).n,0);
    for(const table of ['retained_snapshots','browser_audit_work','prepared_assessment_jobs','prepared_assessment_checkpoints','audit_pipeline_state']) {
      assert.equal(f.sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE audit_id=?`).get(expired).n,0,table);
      assert.equal(f.sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE audit_id=?`).get(ready).n,1,table);
    }
    assert.ok(f.deletes.length>0&&f.deletes.every(key=>key.startsWith('retained/'+expired+'/')));
    assert.equal(f.sql.prepare('SELECT state FROM prepared_assessment_jobs WHERE audit_id=?').get(ready).state,'waiting');
    assert.ok([...f.objects.keys()].some(key=>key.startsWith('retained/'+ready+'/')));
  }finally{f.sql.close();}
});

test('denied usage admission performs no watchdog, deletion, recovery or model call',async()=>{
  const f=await fixture();
  try{
    f.deny();await runScheduledMaintenance({scheduledTime:now},f.env,f.options);
    assert.deepEqual(f.events,['reserve']);assert.equal(f.reads(),0);assert.deepEqual(f.deletes,[]);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM retained_snapshots').get().n,2);
  }finally{f.sql.close();}
});
