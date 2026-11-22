import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createAuditQueue, AUDIT_QUEUE_LEASE_MS, AUDIT_QUEUE_HORIZON_MS} from './audit-queue.mjs';

function fixture(overrides={}) {
 const sql=new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
 sql.exec(readFileSync(new URL('./migrations/0012-audit-queue.sql',import.meta.url),'utf8'));
 sql.prepare("INSERT INTO audits(id,url,cache_key,status,created_at,expires_at) VALUES('a','https://example.com','k','pending',0,99999999)").run();
 const db={prepare(query){return {bind(...args){const s=sql.prepare(query);return {first:async()=>s.get(...args)??null,run:async()=>({meta:{changes:Number(s.run(...args).changes)}})};}};}};
 let time=1;const sent=[],steps=[],finals=[];
 const worker=createAuditQueue({db,queue:{send:async body=>sent.push(body)},reserveSend:async()=>({accepted:true}),runStep:async input=>{steps.push(input);return {next:input.phase==='capture'?'prepare':input.phase==='prepare'?'assess':null};},finalize:async input=>finals.push(input),now:()=>time,...overrides});
 const message=body=>({body,acked:false,retried:false,ack(){this.acked=true;},retry(options){this.retried=options;}});
 return {sql,worker,sent,steps,finals,message,advance:n=>time+=n};
}
test('checkpoints advance and predecessor redelivery repairs a lost handoff without rerunning',async()=>{
 let sends=0;const f=fixture({queue:{send:async()=>{if (++sends===2) throw Error('lost');}}});
 assert.deepEqual(await f.worker.start('a'),{accepted:true});
 assert.equal((await f.worker.pending('a')).expires_at,1+AUDIT_QUEUE_HORIZON_MS);
 const first=f.message({auditId:'a',sequence:0});await f.worker.handle({messages:[first]});assert.ok(first.retried);
 const replay=f.message(first.body);await f.worker.handle({messages:[replay]});assert.ok(replay.acked);assert.equal(f.steps.length,1);
 for (const sequence of [1,2]) {const m=f.message({auditId:'a',sequence});await f.worker.handle({messages:[m]});assert.ok(m.acked);}
 assert.deepEqual(f.steps.map(s=>s.phase),['capture','prepare','assess']);
 const duplicate=f.message({auditId:'a',sequence:2});await f.worker.handle({messages:[duplicate]});assert.ok(duplicate.acked);assert.equal(f.steps.length,3);
});
test('active claims delay duplicate deliveries, expired claims recover, and DLQ terminalizes',async()=>{
 const f=fixture();await f.worker.start('a');
 f.sql.prepare("UPDATE audit_queue_jobs SET state='running',owner='x',lease_until=100 WHERE audit_id='a'").run();
 const m=f.message({auditId:'a',sequence:0});await f.worker.handle({messages:[m]});assert.ok(m.retried.delaySeconds*1000>AUDIT_QUEUE_LEASE_MS);
 f.advance(100);await f.worker.handle({messages:[m]});assert.ok(m.acked);
 const dead=f.message({auditId:'a',sequence:1});await f.worker.handle({messages:[dead]},{deadLetter:true});assert.ok(dead.acked);
 assert.equal(f.finals[0].code,'queue_delivery_exhausted');assert.equal(f.finals[0].sequence,1);assert.ok(f.finals[0].owner);
});
test('failed initial send fences delivery, and denied progression finalizes',async()=>{
 const failed=fixture({queue:{send:async()=>{throw Error('send');}}});await assert.rejects(failed.worker.start('a'));
 const m=failed.message({auditId:'a',sequence:0});await failed.worker.handle({messages:[m]});assert.ok(m.acked);assert.equal(failed.steps.length,0);
 let count=0;const f=fixture({reserveSend:async()=>({accepted:++count===1,reason:'limit'})});await f.worker.start('a');
 const step=f.message({auditId:'a',sequence:0});await f.worker.handle({messages:[step]});assert.ok(step.acked);assert.equal(f.finals[0].code,'queue_budget_denied');
});
test('dead letter of immediate predecessor terminalizes an unsent successor',async()=>{
 let sends=0;const f=fixture({queue:{send:async()=>{if (++sends>1) throw Error('unavailable');}}});
 await f.worker.start('a');const predecessor=f.message({auditId:'a',sequence:0});
 await f.worker.handle({messages:[predecessor]});assert.ok(predecessor.retried);assert.equal((await f.worker.pending('a')).state,'dispatching');
 const dead=f.message(predecessor.body);await f.worker.handle({messages:[dead]},{deadLetter:true});
 assert.ok(dead.acked);assert.equal(f.finals[0].code,'queue_delivery_exhausted');assert.equal(f.finals[0].sequence,1);
});
test('old deliveries do not resend or terminalize an accepted successor',async()=>{
 const f=fixture();await f.worker.start('a');const first=f.message({auditId:'a',sequence:0});await f.worker.handle({messages:[first]});
 assert.equal(f.sent.length,2);const duplicate=f.message(first.body);await f.worker.handle({messages:[duplicate]});assert.ok(duplicate.acked);assert.equal(f.sent.length,2);
 const dead=f.message(first.body);await f.worker.handle({messages:[dead]},{deadLetter:true});assert.ok(dead.acked);assert.equal(f.finals.length,0);
});
test('expired queue horizon terminalizes a live audit and active dispatch claims block repairs',async()=>{
 const f=fixture();await f.worker.start('a');
 f.sql.prepare("UPDATE audit_queue_jobs SET sequence=1,phase='prepare',state='dispatching',owner='other',lease_until=100 WHERE audit_id='a'").run();
 const predecessor=f.message({auditId:'a',sequence:0});await f.worker.handle({messages:[predecessor]});assert.ok(predecessor.retried);assert.equal(f.sent.length,1);
 const dead=f.message(predecessor.body);await f.worker.handle({messages:[dead]},{deadLetter:true});assert.ok(dead.retried);assert.equal(f.finals.length,0);
 f.advance(AUDIT_QUEUE_HORIZON_MS+1);const expired=f.message(predecessor.body);await f.worker.handle({messages:[expired]});assert.ok(expired.acked);assert.equal(f.finals[0].code,'queue_deadline_exceeded');
});

test('dead letter terminalizes an initial send interrupted before activation',async()=>{
 const f=fixture();await f.worker.start('a');
 f.sql.prepare("UPDATE audit_queue_jobs SET state='staged' WHERE audit_id='a'").run();
 const pending=f.message(f.sent[0]);await f.worker.handle({messages:[pending]});assert.ok(pending.retried);
 const dead=f.message(f.sent[0]);await f.worker.handle({messages:[dead]},{deadLetter:true});
 assert.ok(dead.acked);assert.equal(f.steps.length,0);
 assert.equal(f.finals[0].code,'queue_initial_dispatch_unconfirmed');
});
