import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createAuditQueue} from '../../../backend/audit-queue.mjs';

const [mode, exportPath] = process.argv.slice(2);
assert.ok(['export','resume'].includes(mode) && exportPath);
const sql = new DatabaseSync(':memory:');
sql.exec(readFileSync(new URL('../../../backend/schema.sql',import.meta.url),'utf8'));
const db = {prepare(query) {return {bind(...params) {
  const statement = sql.prepare(query);
  return {first:async()=>statement.get(...params)??null,run:async()=>({meta:{changes:Number(statement.run(...params).changes)}})};
}};}};
const auditId = '22222222-2222-4222-8222-222222222222';
const sent = [];
let calls = 0;
let time = 1000;
const runtime = createAuditQueue({
  db,now:()=>time,reserveSend:async()=>({accepted:true}),
  queue:{async send(body) {
    if (mode==='export' && body.sequence===3) throw Error('synthetic handoff interruption');
    sent.push(body);
  }},
  async runStep({phase}) {
    if(phase==='capture') return {next:'prepare'};
    if(phase==='prepare') return {next:'assess'};
    calls++;
    time+=10;
    return {next:calls===1?'assess':null};
  },
  finalize:async()=>assert.fail('unexpected terminal fallback'),
});
async function deliver(body) {
  let acked=false,retried=false;
  await runtime.handle({messages:[{body,ack(){acked=true;},retry(){retried=true;}}]});
  return {acked,retried};
}
try {
  if(mode==='export') {
    sql.prepare("INSERT INTO audits (id,url,cache_key,status,created_at,expires_at) VALUES(?,'https://example.com/test','fixture','pending',1000,86401000)").run(auditId);
    assert.deepEqual(await runtime.start(auditId),{accepted:true});
    for(let sequence=0;sequence<2;sequence++) {
      const delivery=sent.shift();
      assert.equal(delivery.sequence,sequence);
      assert.deepEqual(await deliver(delivery),{acked:true,retried:false});
    }
    const unacknowledged=sent.shift();
    assert.equal(unacknowledged.sequence,2);
    assert.deepEqual(await deliver(unacknowledged),{acked:false,retried:true});
    const audit=sql.prepare('SELECT id,url,cache_key,status,created_at,expires_at FROM audits WHERE id=?').get(auditId);
    const job=await runtime.pending(auditId);
    assert.equal(job.state,'dispatching');
    assert.equal(job.sequence,3);
    assert.equal(calls,1);
    writeFileSync(exportPath,JSON.stringify({version:1,audit,job,unacknowledged,calls,time},null,2)+'\n');
    console.log('Exported one completed simulated assessment step and a pending successor send.');
  } else {
    const exported=JSON.parse(readFileSync(exportPath,'utf8'));
    assert.equal(exported.version,1);
    calls=exported.calls;
    time=exported.time;
    const {audit,job,unacknowledged}=exported;
    sql.prepare('INSERT INTO audits (id,url,cache_key,status,created_at,expires_at) VALUES(?,?,?,?,?,?)')
      .run(audit.id,audit.url,audit.cache_key,audit.status,audit.created_at,audit.expires_at);
    sql.prepare('INSERT INTO audit_queue_jobs (audit_id,phase,sequence,state,owner,lease_until,code,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(job.audit_id,job.phase,job.sequence,job.state,job.owner,job.lease_until,job.code,job.updated_at,job.expires_at);
    assert.deepEqual(await deliver(unacknowledged),{acked:true,retried:false});
    assert.equal(calls,1);
    assert.deepEqual(sent,[{auditId,sequence:3}]);
    assert.deepEqual(await deliver(sent.shift()),{acked:true,retried:false});
    assert.equal(calls,2);
    assert.equal((await runtime.pending(auditId)).state,'complete');
    assert.deepEqual(await deliver(unacknowledged),{acked:true,retried:false});
    assert.equal(calls,2);
    console.log(JSON.stringify({repairCalls:0,successorCalls:1,duplicateCalls:0,terminalState:'complete'}));
  }
} finally {sql.close();}
