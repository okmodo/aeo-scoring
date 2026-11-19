import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createQuickActionAllowanceGuard, QUICK_ACTION_HOLD_MS as hold} from './quick-action-allowance.mjs';
import {createBrowserAllowanceGuard, BROWSER_CONTROLS_VERSION} from './browser-allowance.mjs';
const now=1_700_000_000_000;
function setup() {
 const sqlite=new DatabaseSync(':memory:'); for (const name of ['0006-browser-allowances.sql','0009-quick-action-allowances.sql']) sqlite.exec(readFileSync(new URL(`./migrations/${name}`,import.meta.url),'utf8'));
 const db={prepare(sql){return {bind(...args){const s=sqlite.prepare(sql);return {run:async()=>s.run(...args),first:async()=>s.get(...args)??null};}};}};
 const e={accountId:'a',cycleStart:now-100,cycleEnd:now+30*86_400_000,observedAt:now,usageMs:0,complete:true};
 return {sqlite,db,e,guard:createQuickActionAllowanceGuard(db,{accountId:'a',collect:async()=>e,clock:()=>now})};
}
const reserve=(g,id)=>g.reserve({id,maxDurationMs:hold,now});
test('serializes reservations and starts, retains unknown response and settles verified header',async()=>{
 const {guard:g}=setup(); const all=await Promise.all(Array.from({length:8},(_,i)=>reserve(g,String(i)))); assert.equal(all.filter(x=>x.accepted).length,1);
 assert.equal((await reserve(g,'0')).duplicate,true); assert.equal((await g.start({id:'0',now})).accepted,true); assert.equal((await g.start({id:'0',now})).accepted,false);
 for(const response of [new Response('',{headers:{'X-Origin-Ms-Used':'0'}}),new Response('',{headers:{'X-Browser-Ms-Used':'NaN'}}),new Response('',{headers:{'X-Browser-Ms-Used':'-1'}})]) assert.equal((await g.settle({id:'0',response,now})).reason,'unknown_usage');
 assert.equal((await reserve(g,'other')).accepted,false);
 assert.equal((await g.settle({id:'0',response:new Response('',{headers:{'X-Browser-Ms-Used':'0'}}),now})).accepted,true);
 assert.equal((await g.settle({id:'0',now})).duplicate,true); assert.equal((await reserve(g,'other')).accepted,true);
});
test('fails closed for stale evidence and unsettled legacy leases',async()=>{
 const {guard:g,e,sqlite}=setup(); e.observedAt=now-300001; assert.equal((await reserve(g,'a')).reason,'invalid_evidence'); e.observedAt=now;
 sqlite.prepare('INSERT INTO browser_allowance_leases(account_id,id,cycle_start,duration_ms,created_at) VALUES(?,?,?,?,?)').run('a','legacy',e.cycleStart,100,now);
 assert.equal((await reserve(g,'a')).accepted,false);
});
test('accounts for confirmed legacy and quick usage without double counting reported usage',async()=>{
 const {guard:g,e,sqlite}=setup(); e.usageMs=17_000_000;
 sqlite.prepare('INSERT INTO browser_allowance_leases(account_id,id,cycle_start,duration_ms,created_at,launch_started_at,actual_ms,settled_at) VALUES(?,?,?,?,?,?,?,?)').run('a','legacy',e.cycleStart,100,now,now,100,now);
 assert.equal((await reserve(g,'a')).accepted,true); await g.start({id:'a',now});
 const response=new Response('',{headers:{'X-Browser-Ms-Used':'900000.2'}}); assert.equal((await g.settle({id:'a',response,now})).accepted,true);
 e.usageMs=17_900_001; assert.equal((await reserve(g,'b')).accepted,false);
});
test('overrun is recorded and missing outer header cannot be supplied by metadata',async()=>{
 const {guard:g,sqlite}=setup(); await reserve(g,'x'); await g.start({id:'x',now});
 assert.equal((await g.settle({id:'x',response:{headers:new Headers({'X-Browser-Ms-Used':'0'}),meta:{headers:{'X-Browser-Ms-Used':'0'}}},now})).accepted,false);
 const result=await g.settle({id:'x',response:new Response('',{headers:{'X-Browser-Ms-Used':'3720000.1'}}),now}); assert.equal(result.overrun,true);
 assert.equal(sqlite.prepare('SELECT actual_ms FROM quick_action_allowance_leases').get().actual_ms,3720001);
});
test('cutover interlock prevents either lease generation entering while the other is pending',async()=>{
 const {guard:g,e,sqlite}=setup();
 const insert=sqlite.prepare('INSERT OR IGNORE INTO browser_allowance_leases(account_id,id,cycle_start,duration_ms,created_at) VALUES(?,?,?,?,?)');
 assert.equal((await reserve(g,'quick')).accepted,true);
 assert.equal(insert.run('a','legacy',e.cycleStart,100,now).changes,0);
 assert.equal((await g.cancelUnstarted({id:'quick',now})).accepted,true);
 assert.equal(insert.run('a','legacy',e.cycleStart,100,now).changes,1);
 assert.equal((await reserve(g,'quick2')).accepted,false);
});
test('header values require decimal milliseconds and only outer headers count',async()=>{
 for (const invalid of ['', '1e2', '+1', 'Infinity', '1.2.3']) {
  const {guard:g}=setup(); await reserve(g,'x'); await g.start({id:'x',now});
  const response=new Response('',{headers:{'X-Browser-Ms-Used':invalid}});
  assert.equal((await g.settle({id:'x',response,now})).reason,'unknown_usage');
 }
 const {guard:g,sqlite}=setup(); await reserve(g,'x'); await g.start({id:'x',now});
 const outer=new Response(JSON.stringify({meta:{headers:{'X-Browser-Ms-Used':'0'}},headers:{'X-Browser-Ms-Used':'0'}}),{headers:{'X-Browser-Ms-Used':'1.01'}});
 assert.equal((await g.settle({id:'x',response:outer,now})).accepted,true);
 assert.equal(sqlite.prepare('SELECT actual_ms FROM quick_action_allowance_leases').get().actual_ms,2);
});
test('unknown holds persist across cycles and confirmed legacy totals survive rollover',async()=>{
 const {guard:g,e,sqlite}=setup(); await reserve(g,'x'); await g.start({id:'x',now});
 const next=e.cycleEnd+1; e.cycleStart=e.cycleEnd; e.cycleEnd=e.cycleStart+30*86_400_000; e.observedAt=next;
 assert.equal((await g.reserve({id:'next',maxDurationMs:hold,now:next})).accepted,false);
 assert.equal((await g.settle({id:'x',response:new Response('',{headers:{'X-Browser-Ms-Used':'1'}}),now:next})).accepted,true);
 sqlite.prepare('INSERT INTO browser_allowance_leases(account_id,id,cycle_start,duration_ms,created_at,launch_started_at,actual_ms,settled_at) VALUES(?,?,?,?,?,?,?,?)').run('a','legacy',e.cycleStart,1,next,next,18_000_000,next);
 assert.equal((await g.reserve({id:'next',maxDurationMs:hold,now:next})).accepted,false);
});

test('old legacy guard cannot admit after a started Quick Action settles',async()=>{
 const {guard:g,db,e}=setup();
 assert.equal((await reserve(g,'quick')).accepted,true);
 assert.equal((await g.start({id:'quick',now})).accepted,true);
 assert.equal((await g.settle({id:'quick',response:new Response('',{headers:{'X-Browser-Ms-Used':'100'}}),now})).accepted,true);
 const legacy=createBrowserAllowanceGuard(db,{accountId:'a',capability:{version:BROWSER_CONTROLS_VERSION,maxDurationMs:1000,cleanupAfterMs:200},collect:async()=>({...e,concurrencyUnits:0,activeSessions:0})});
 assert.equal((await legacy.reserve({id:'legacy',maxDurationMs:1000,now})).accepted,false);
});
