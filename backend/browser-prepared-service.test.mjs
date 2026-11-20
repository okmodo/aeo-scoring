import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditService, runPreparation } from './service.mjs';

const id='d9428888-122b-4c77-8d11-666666666666';
const env={AUDIT_DB:{},AUDIT_USAGE_READ_TOKEN:'token',AUDIT_SNAPSHOTS:{},AUDIT_BROWSER:{}};

test('preparation reserves before claiming and publishes before notification', async () => {
  const events=[];
  const allowance={reserve:async()=>{events.push('reserve');return {accepted:true,duplicate:false};},settle:async()=>events.push('settle')};
  const workflow={claim:async()=>{events.push('claim');return true;},read:async(_id,options)=>{assert.equal(options.preparedOnly,true);events.push('publish')}};
  assert.deepEqual(await runPreparation({env,auditId:id,allowance,workflow}),{status:'ready'});
  assert.deepEqual(events,['reserve','claim','publish','settle']);
  events.length=0;
  allowance.reserve=async()=>({accepted:false});
  assert.deepEqual(await runPreparation({env,auditId:id,allowance,workflow}),{status:'skipped'});
  assert.deepEqual(events,[]);
});

test('capture notifies only after stored work is ready and polling never starts parsing', async () => {
  const events=[]; let task;
  const audit={id,url:'https://example.com/',status:'pending',createdAt:1,expiresAt:86400001};
  const flow={prepare:async()=>({accepted:true}),capture:async()=>events.push('ready'),claim:async()=>assert.fail('poll claimed preparation')};
  const handle=createAuditService({store:{reserve:async()=>({kind:'created',audit}),get:async()=>audit},allowance:{reserve:async()=>({accepted:true,duplicate:false})},browserFlow:flow,requireBrowser:true,snapshotStore:{},egress:{fetch(){}},secret:'x'.repeat(32),normalizeUrl:x=>x,now:()=>1,dispatchPreparation:async()=>events.push('dispatch')});
  const options={address:'192.0.2.1',defer:p=>{task=p;}};
  assert.equal((await handle(new Request('https://worker/api/v1/audits',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:audit.url})}),options)).status,202);
  await task;
  assert.deepEqual(events,['ready','dispatch']);
  assert.equal((await handle(new Request('https://worker/api/v1/audits/'+id),options)).status,200);
});

test('preparation releases its claim after failure', async () => {
  let released=false;
  const allowance={reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>{}};
  const workflow={claim:async()=>true,read:async()=>{throw Error('failure');},release:async()=>{released=true;}};
  await assert.rejects(runPreparation({env,auditId:id,allowance,workflow}));
  assert.equal(released,true);
});

test('private continuation has no HTTP route', async () => {
  const {default:worker}=await import('./public-worker.mjs');
  for (const path of ['/prepare','/assess','/internal/prepare']) {
    const response=await worker.fetch(new Request('https://worker'+path,{method:'POST'}),{}, {waitUntil(){}});
    assert.equal(response.status,404);
  }
});

test('hourly maintenance rediscovers missed preparation without a poll', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const {runScheduledMaintenance}=await import('./service.mjs');
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec("CREATE TABLE browser_audit_work(audit_id TEXT,state TEXT,created_at INTEGER,expires_at INTEGER); CREATE TABLE retained_snapshots(audit_id TEXT,state TEXT,expires_at INTEGER,prepared_state TEXT); CREATE TABLE audits(id TEXT,status TEXT,expires_at INTEGER)");
  const now=1000000;
  for(const [auditId,state,lease,prepared] of [[id,'ready',1,null],['active','assessing',now+1,null],['reclaim','assessing',1,null],['prepared','ready',1,'ready']]) {
    sqlite.prepare('INSERT INTO browser_audit_work VALUES(?,?,?,?)').run(auditId,state,1,lease);
    sqlite.prepare('INSERT INTO retained_snapshots VALUES(?,?,?,?)').run(auditId,'ready',now+10000,prepared);
    sqlite.prepare('INSERT INTO audits VALUES(?,?,?)').run(auditId,'pending',now+10000);
  }
  const events=[];
  const db={prepare(sql){return{bind(...args){const s=sqlite.prepare(sql);return{all:async()=>({results:s.all(...args)})};}};}};
  const allowance={reserve:async()=>{events.push('reserve');return{accepted:true,duplicate:false};},settle:async()=>events.push('settle')};
  const env={AUDIT_DB:db,AUDIT_USAGE_READ_TOKEN:'fixture',AUDIT_SELF:{prepare:async value=>events.push(value),assess:async()=>{} }};
  await runScheduledMaintenance({scheduledTime:now+60000},env,{now,allowance});
  assert.deepEqual(events,['reserve','settle',id,'reclaim']);
  sqlite.close();
});

test('interrupted pending publication becomes incomplete after the original audit lease', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const {readFileSync}=await import('node:fs');
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  const timestamp=1_000_000, expiry=timestamp+100_000, lease=timestamp+30_000;
  sqlite.prepare("INSERT INTO audits(id,url,cache_key,status,created_at,expires_at,lease_ms) VALUES(?,?,?,'pending',?,?,120000)").run(id,'https://example.com/','key',1,expiry);
  sqlite.prepare("INSERT INTO retained_snapshots(audit_id,object_prefix,created_at,expires_at,state,prepared_state) VALUES(?,?,?,?,'ready','pending')").run(id,'retained/x',1,expiry);
  sqlite.prepare("INSERT INTO browser_audit_work VALUES(?,'assessing',?,?)").run(id,1,lease);
  const db={prepare(sql){return{bind(...args){const s=sqlite.prepare(sql);return{first:async()=>s.get(...args)??null,run:async()=>({meta:{changes:Number(s.run(...args).changes)}})};}};}};
  const workflow={claimPreparation:async()=>({expires_at:lease}),read:async()=>assert.fail('pending publication must not be read or parsed'),finish:async()=>{},release:async()=>{}};
  const allowance={reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>{}};
  await assert.rejects(runPreparation({env:{...env,AUDIT_DB:db},auditId:id,now:()=>timestamp,workflow,allowance}));
  const row=sqlite.prepare('SELECT status,report_json FROM audits WHERE id=?').get(id);
  assert.equal(row.status,'incomplete');assert.equal(JSON.parse(row.report_json).score,null);
  assert.equal(sqlite.prepare('SELECT prepared_state FROM retained_snapshots WHERE audit_id=?').get(id).prepared_state,'pending');
  sqlite.prepare("UPDATE audits SET status='pending',report_json=NULL WHERE id=?").run(id);
  let released=false;
  const racingDb={prepare(sql){return{bind(...args){const s=sqlite.prepare(sql);return{first:async()=>{const row=s.get(...args)??null;if(sql.startsWith('SELECT url')) sqlite.prepare("UPDATE retained_snapshots SET prepared_state='ready' WHERE audit_id=?").run(id);return row;},run:async()=>({meta:{changes:Number(s.run(...args).changes)}})};}};}};
  await assert.rejects(runPreparation({env:{...env,AUDIT_DB:racingDb},auditId:id,now:()=>timestamp,workflow:{...workflow,release:async()=>{released=true;}},allowance}));
  assert.equal(sqlite.prepare('SELECT status FROM audits WHERE id=?').get(id).status,'pending');
  assert.equal(released,true);
  sqlite.close();
});
