import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createR2AllowanceGuard, R2_CEILINGS} from './allowance-r2.mjs';
import {collectR2Usage} from './analytics-r2.mjs';
const now = Date.UTC(2026, 10, 17);
function setup(collect) {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync(new URL('./migrations/0004-r2-allowances.sql',import.meta.url),'utf8'));
  const db={prepare(sql){return {bind(...args){const s=sqlite.prepare(sql);return {run:async()=>s.run(...args),first:async()=>s.get(...args)??null};}};}};
  return createR2AllowanceGuard(db,{accountId:'account',allocations:{...R2_CEILINGS,r2ClassA:10,r2StorageBytes:10}}, {collect});
}
const snapshot = (at, a=0, storage=0) => ({observedAt:at,r2StorageBytes:storage,r2ClassA:a,r2ClassB:0});
test('concurrent holds, settlement and overlapping provider estimates are conservative without double counting',async()=>{
  let observed=2; const guard=setup(async ({now:at})=>snapshot(at,observed));
  const reserve=(id,n)=>guard.reserve({id,now,costs:{r2ClassA:n}});
  const decisions=await Promise.all([reserve('a',4),reserve('b',4),reserve('c',4)]);
  assert.equal(decisions.filter(x=>x.accepted).length,2);
  assert.equal((await guard.settle({id:'a'})).accepted,true); observed=6;
  assert.equal((await reserve('d',1)).accepted,false);
  assert.equal((await guard.settle({id:'b'})).accepted,true);
  assert.equal((await reserve('a',4)).duplicate,true);
  assert.equal((await reserve('x',1)).reason,'allowance_exhausted');
});
test('unknown holds persist and collection failure never authorizes reuse',async()=>{
  let fail=false; const guard=setup(async ({now:at})=>{if(fail) throw Error('secret');return snapshot(at,0,4);});
  assert.equal((await guard.reserve({id:'a',now,costs:{r2StorageBytes:6}})).accepted,true);
  assert.equal((await guard.reserve({id:'b',now:now+40*86400000,costs:{r2StorageBytes:1}})).reason,'allowance_exhausted');
  fail=true; assert.equal((await guard.reserve({id:'c',now:now+1,costs:{r2ClassA:1}})).reason,'invalid_evidence');
});
test('collector includes all statuses and fails on absent account storage',async()=>{
  const calls=[]; const payload={success:true,errors:[],result:{standard:{published:{payloadSize:5,metadataSize:1},uploaded:{payloadSize:2,metadataSize:1}}}};
  const result={data:{viewer:{accounts:[{r2StorageAdaptiveGroups:[],r2OperationsAdaptiveGroups:[{dimensions:{actionType:'PutObject'},sum:{requests:4}},{dimensions:{actionType:'GetObject'},sum:{requests:2}},{dimensions:{actionType:'NewOperation'},sum:{requests:1}}]}]}}};
  const fetch=async (url,opts)=>{calls.push({url,opts});return new Response(JSON.stringify(url.endsWith('/graphql')?result:payload));};
  const options={accountId:'a'.repeat(32),token:'token',now,fetch};
  assert.deepEqual(await collectR2Usage(options),{...snapshot(now,5,9),r2ClassB:3});
  assert.match(calls[1].opts.body,/r2OperationsAdaptiveGroups/);
  result.data.viewer.accounts[0].r2StorageAdaptiveGroups.push({dimensions:{bucketName:'old'},max:{payloadSize:20,metadataSize:2}});
  assert.equal((await collectR2Usage(options)).r2StorageBytes,22);
  result.data.viewer.accounts[0].r2StorageAdaptiveGroups = null;
  await assert.rejects(()=>collectR2Usage(options));
  result.data.viewer.accounts[0].r2StorageAdaptiveGroups = [];
  delete payload.result.standard.uploaded; await assert.rejects(()=>collectR2Usage(options));
});

 test('caches only fresh successful collections and refreshes at five minutes',async()=>{
  let calls=0; const guard=setup(async ({now:at})=>{calls++;return snapshot(at);});
  for (const [id,at] of [['a',now],['b',now+299999],['c',now+300000]]) assert.equal((await guard.reserve({id,now:at,costs:{r2ClassB:1}})).accepted,true);
  assert.equal(calls,2);
});
