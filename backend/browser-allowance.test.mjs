import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createBrowserAllowanceGuard, BROWSER_CONTROLS_VERSION } from './browser-allowance.mjs';
const now=1_700_000_000_000;
function setup() {
  const sqlite=new DatabaseSync(':memory:'); sqlite.exec(readFileSync(new URL('./migrations/0006-browser-allowances.sql',import.meta.url),'utf8'));
  const db={prepare(sql){return {bind(...args){const s=sqlite.prepare(sql);return {run:async()=>s.run(...args),first:async()=>s.get(...args)??null,all:async()=>({results:s.all(...args)})};}};}};
  const e={accountId:'a',cycleStart:now-100,cycleEnd:now+30*86_400_000,observedAt:now,usageMs:0,concurrencyUnits:0,activeSessions:0,complete:true};
  let closed, time=now, verify=async()=>closed;
  const guard=createBrowserAllowanceGuard(db,{accountId:'a',capability:{version:BROWSER_CONTROLS_VERSION,maxDurationMs:1000,cleanupAfterMs:200},collect:async()=>e,verifyClosed:request=>verify(request),clock:()=>time});
  return {guard,e,sqlite,close:v=>{closed=v;},setTime:v=>{time=v;},setVerify:v=>{verify=v;}};
}
const reserve=(guard,id)=>guard.reserve({id,maxDurationMs:1000,now});
test('serializes leases, retains unknowns, and settles only provider closure',async()=>{
  const {guard,close}=setup(); const all=await Promise.all(Array.from({length:8},(_,i)=>reserve(guard,String(i))));
  assert.equal(all.filter(x=>x.accepted).length,1);
  assert.equal((await reserve(guard,'0')).duplicate,true);
  assert.equal((await guard.startLaunch({id:'0',now})).accepted,true);
  assert.equal((await guard.bindSession({id:'0',sessionId:'s'})).accepted,true);
  assert.equal((await guard.settle({id:'0',now})).reason,'unknown_usage');
  assert.equal((await reserve(guard,'later')).accepted,false);
  close({sessionId:'s',closed:true,durationMs:400,observedAt:now});
  assert.equal((await guard.settle({id:'0',now})).accepted,true);
  assert.equal((await guard.settle({id:'0',now})).duplicate,true);
  assert.equal((await reserve(guard,'later')).accepted,true);
});
test('fails closed on missing hard lifetime, stale or incomplete metrics, and account peaks',async()=>{
  const {guard,e}=setup(); e.complete=false; assert.equal((await reserve(guard,'x')).reason,'invalid_evidence');
  e.complete=true;e.observedAt=now-300001;assert.equal((await reserve(guard,'x')).reason,'invalid_evidence');
  e.observedAt=now;e.concurrencyUnits=168;assert.equal((await reserve(guard,'x')).reason,'allowance_exhausted');
  assert.equal((await createBrowserAllowanceGuard().reserve({id:'x',maxDurationMs:1000,now})).accepted,false);
});

test('watchdog only closes recorded expired owned sessions and keeps unknowns',async()=>{
  const {guard,close,setTime}=setup(); assert.equal((await reserve(guard,'one')).accepted,true);
  setTime(now+2000);
  await guard.startLaunch({id:'one',now});
  assert.equal((await guard.watchdog({now:now+2000,closeOwnedSession:async()=>assert.fail('unknown session')})).examined,0);
  await guard.startLaunch({id:'one',now}); await guard.bindSession({id:'one',sessionId:'owned'}); const seen=[];
  await guard.watchdog({now:now+2000,closeOwnedSession:async id=>seen.push(id)});
  assert.deepEqual(seen,['owned']); assert.equal((await reserve(guard,'two')).accepted,false);
  close({sessionId:'owned',closed:true,durationMs:1100,observedAt:now+2000});
  await guard.watchdog({now:now+2000,closeOwnedSession:async()=>{}});
  assert.equal((await reserve(guard,'two')).accepted,true);
});
test('refreshed account estimate does not double count a local completion',async()=>{
 const {guard,e,close}=setup(); e.usageMs=21_598_000;
 assert.equal((await reserve(guard,'one')).accepted,true);
 await guard.startLaunch({id:'one',now}); await guard.bindSession({id:'one',sessionId:'owned'}); close({sessionId:'owned',closed:true,durationMs:1000,observedAt:now});
 await guard.settle({id:'one',now}); e.usageMs=21_599_000;
 assert.equal((await reserve(guard,'two')).accepted,true);
});

test('local completed sessions consume the conservative count bound during analytics lag',async()=>{
  const {guard,e,close}=setup(); e.concurrencyUnits=138;
  assert.equal((await reserve(guard,'one')).accepted,true);
  await guard.startLaunch({id:'one',now}); await guard.bindSession({id:'one',sessionId:'owned'});
  close({sessionId:'owned',closed:true,durationMs:500,observedAt:now}); await guard.settle({id:'one',now});
  assert.equal((await reserve(guard,'two')).reason,'allowance_exhausted');
});

test('local presence floor rounds multi-day durations upward',async()=>{
  const {guard,e,close}=setup(); e.concurrencyUnits=136;
  assert.equal((await reserve(guard,'one')).accepted,true);
  await guard.startLaunch({id:'one',now}); await guard.bindSession({id:'one',sessionId:'owned'});
  close({sessionId:'owned',closed:true,durationMs:86_400_001,observedAt:now});
  await guard.settle({id:'one',now});
  assert.equal((await reserve(guard,'two')).accepted,false);
});

test('watchdog uses the application deadline rather than the larger reservation',async()=>{
  const {guard}=setup(); assert.equal((await reserve(guard,'one')).accepted,true);
  await guard.startLaunch({id:'one',now}); await guard.bindSession({id:'one',sessionId:'owned'}); const seen=[];
  await guard.watchdog({now:now+199,closeOwnedSession:async id=>seen.push(id)});
  assert.deepEqual(seen,[]);
  await guard.watchdog({now:now+200,closeOwnedSession:async id=>seen.push(id)});
  assert.deepEqual(seen,['owned']);
  assert.equal((await reserve(guard,'two')).accepted,false);
});

test('start and cancellation race cannot launch a canceled lease',async()=>{
  const {guard}=setup(); await reserve(guard,'race');
  const [start,cancel]=await Promise.all([guard.startLaunch({id:'race',now}),guard.cancelUnstarted({id:'race',now})]);
  assert.equal(Number(start.accepted)+Number(cancel.accepted),1);
  assert.equal((await guard.startLaunch({id:'race',now})).accepted,false);
});
test('watchdog cancels expired known-unstarted lease but keeps started unknown',async()=>{
  const {guard}=setup(); await reserve(guard,'unstarted');
  await guard.watchdog({now:now+200,closeOwnedSession:async()=>assert.fail('no session')});
  assert.equal((await reserve(guard,'started')).accepted,true);
  await guard.startLaunch({id:'started',now});
  await guard.watchdog({now:now+200,closeOwnedSession:async()=>assert.fail('unknown session')});
  assert.equal((await reserve(guard,'blocked')).accepted,false);
});

test('a delayed start cannot use an expired launch grant',async()=>{
  const {guard}=setup(); await reserve(guard,'late');
  assert.equal((await guard.startLaunch({id:'late',now:now+200})).accepted,false);
  assert.equal((await guard.cancelUnstarted({id:'late',now:now+200})).accepted,true);
});

test('settlement validates fresh post-response observation and records it',async()=>{
  const {guard,close,setTime,sqlite}=setup(); await reserve(guard,'one');
  await guard.startLaunch({id:'one',now}); await guard.bindSession({id:'one',sessionId:'owned'});
  close({sessionId:'owned',closed:true,durationMs:1200,observedAt:now+25});
  setTime(now+24); assert.equal((await guard.settle({id:'one',now})).reason,'unknown_usage');
  setTime(now+25); assert.deepEqual(await guard.settle({id:'one',now}),{accepted:true,duplicate:false,overrun:true});
  assert.equal(sqlite.prepare('SELECT settled_at FROM browser_allowance_leases WHERE id=?').get('one').settled_at,now+25);
  assert.equal((await guard.settle({id:'one',now})).duplicate,true);
});
test('settlement retains unknown for stale, malformed, future and clock rollback proof',async()=>{
  const {guard,close,setTime}=setup(); await reserve(guard,'one');
  await guard.startLaunch({id:'one',now}); await guard.bindSession({id:'one',sessionId:'owned'});
  for (const proof of [
    {sessionId:'owned',closed:true,durationMs:1,observedAt:now-1},
    {sessionId:'other',closed:true,durationMs:1,observedAt:now},
    {sessionId:'owned',closed:true,durationMs:-1,observedAt:now},
    {sessionId:'owned',closed:true,durationMs:1,observedAt:now+1},
  ]) { close(proof); assert.equal((await guard.settle({id:'one',now})).reason,'unknown_usage'); }
  close({sessionId:'owned',closed:true,durationMs:1,observedAt:now}); setTime(now+300001);
  assert.equal((await guard.settle({id:'one',now})).reason,'unknown_usage');
  setTime(now-1);
  assert.equal((await guard.settle({id:'one',now})).reason,'unknown_usage');
  assert.equal((await reserve(guard,'two')).accepted,false);
});

test('clock advances while provider closure verification is in flight',async()=>{
  const {guard,setTime,setVerify,sqlite}=setup(); await reserve(guard,'one');
  await guard.startLaunch({id:'one',now}); await guard.bindSession({id:'one',sessionId:'owned'});
  setVerify(async()=>{ await Promise.resolve(); setTime(now+50); return {sessionId:'owned',closed:true,durationMs:50,observedAt:now+50}; });
  assert.equal((await guard.settle({id:'one',now})).accepted,true);
  assert.equal(sqlite.prepare('SELECT settled_at FROM browser_allowance_leases WHERE id=?').get('one').settled_at,now+50);
});
