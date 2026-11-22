import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createAuditQueueAllowance, collectAuditQueueUsage} from './audit-queue-allowance.mjs';

const now = Date.UTC(2026,10,21), day = 86400000;
const config = {accountId:'a'.repeat(32),subscriptionId:'sub',token:'token'};
function setup(collect) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./migrations/0013-audit-queue-allowance.sql',import.meta.url),'utf8'));
  const db = {prepare(sql) {return {bind(...args) {const stmt=sqlite.prepare(sql); return {run:async()=>stmt.run(...args),first:async()=>stmt.get(...args)??null};}};}};
  return {sqlite, guard:createAuditQueueAllowance(db,config,{collect})};
}
const snapshot = (at, operations=0, start=now-day, end=now+day) => ({...config,mode:'estimated',observedAt:at,cycleStart:start,cycleEnd:end,operations});

test('admission conservatively combines account total and local reservations atomically',async()=>{
  const {sqlite,guard}=setup(async({now:at})=>snapshot(at,599980));
  const decisions=await Promise.all([guard.reserve({now}),guard.reserve({now}),guard.reserve({now})]);
  assert.equal(decisions.filter(x=>x.accepted).length,2);
  assert.equal(sqlite.prepare('SELECT SUM(operations) AS n FROM audit_queue_reservations').get().n,20);
});
test('rollover retains 24 hours of previous reservations and does not lower high water',async()=>{
  let cycle=now-day, usage=599980;
  const {guard}=setup(async({now:at})=>snapshot(at,usage,cycle,cycle+2*day));
  assert.equal((await guard.reserve({now})).accepted,true);
  usage=0;
  assert.equal((await guard.reserve({now:now+1})).accepted,true);
  assert.equal((await guard.reserve({now:now+2})).accepted,false);
  cycle=now+3; usage=599980;
  assert.equal((await guard.reserve({now:now+3})).accepted,false);
});
test('collection failure and malformed snapshots fail closed',async()=>{
  for (const collect of [async()=>{throw Error('offline')},async()=>snapshot(now,NaN),async()=>({...snapshot(now),accountId:'other'})]) {
    assert.deepEqual(await setup(collect).guard.reserve({now}),{accepted:false,reason:'invalid_evidence'});
  }
});
test('collector queries account-wide queue operations and validates subscription',async()=>{
  const calls=[];
  const fetch=async(url, options)=>{calls.push([url,options]);return Response.json(calls.length===1 ? {success:true,errors:[],result:[{id:'sub',current_period_start:new Date(now-day).toISOString(),current_period_end:new Date(now+day).toISOString()}]} : {data:{viewer:{accounts:[{queueMessageOperationsAdaptiveGroups:[{sum:{billableOperations:42}}]}]}}});};
  const result=await collectAuditQueueUsage({...config,now,fetch});
  assert.equal(result.operations,42);
  assert.match(JSON.parse(calls[1][1].body).query,/queueMessageOperationsAdaptiveGroups/);
  assert.match(JSON.parse(calls[1][1].body).query,/billableOperations/);
  await assert.rejects(collectAuditQueueUsage({...config,now,fetch:async()=>Response.json({success:true,errors:[],result:[]})}));
});

test('whole boundary day is counted and old buckets are excluded',async()=>{
  const start=now+day/2;
  const {sqlite,guard}=setup(async({now:at})=>snapshot(at,599980,start,start+day));
  const insert=sqlite.prepare('INSERT INTO audit_queue_reservations VALUES (?, ?, ?)');
  insert.run(config.accountId,now-day,10);
  insert.run(config.accountId,now-2*day,100000);
  assert.equal((await guard.reserve({now:start+1})).accepted,true);
  assert.equal((await guard.reserve({now:start+2})).accepted,false);
});
