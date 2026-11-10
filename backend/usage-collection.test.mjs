import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runUsageCollection } from './usage-collection.mjs';

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url),'utf8'));
  const db = { prepare(sql) { return { bind(...args) { const s=sqlite.prepare(sql);return {first:async()=>s.get(...args)??null,run:async()=>s.run(...args)}; } }; } };
  return {sqlite,db};
}
test('collection invalidates prior admission before transport, including acquisition failure',async()=>{
  const {sqlite,db}=setup();
  sqlite.exec("INSERT INTO allowance_receipts(account_id,generation,active)VALUES('a',1,1)");
  try {
    const result=await runUsageCollection({db,config:{accountId:'a',subscriptionId:'s'},now:()=>10,collect:async()=>{
      assert.equal(sqlite.prepare('SELECT active FROM allowance_receipts').get().active,0);
      throw Error('provider error with sensitive text');
    }});
    assert.equal(result.admissionEnabled,false);
    assert.deepEqual(result.receipt.diagnostics,['collection_failed']);
    assert.equal(JSON.stringify(result).includes('sensitive'),false);
    assert.equal(sqlite.prepare('SELECT active FROM allowance_receipts').get().active,0);
  } finally {sqlite.close();}
});

test('operator CLI replays frozen transport privately and cannot activate a budget',()=>{
  const directory=mkdtempSync(join(tmpdir(),'aeo-usage-cli-'));
  try {
    const file=join(directory,'state.sqlite');
    const args=[new URL('./usage-collector-cli.mjs',import.meta.url).pathname,'--fixture',new URL('./fixtures/usage-collector/diagnostic.v1.json',import.meta.url).pathname,'--db',file];
    const first=spawnSync(process.execPath,args,{encoding:'utf8',env:{...process.env,CLOUDFLARE_BILLING_READ_TOKEN:'credential-canary-do-not-print'}});
    assert.equal(first.status,2,first.stderr);
    assert.equal(first.stdout.includes('credential-canary'),false);
    const data=JSON.parse(first.stdout);
    assert.equal(data.sourceMode,'offline_fixture');
    assert.equal(data.admissionEnabled,false);
    assert.equal(data.receipt.metrics.requests.observedQuantity,25);
    assert.equal(data.receipt.metrics.aiNeurons,null);
    assert.equal(statSync(file).mode&0o077,0);
    const second=spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.equal(second.status,2,second.stderr);
    assert.equal(JSON.parse(second.stdout).generation,2);
    const db=new DatabaseSync(file);
    assert.equal(db.prepare('SELECT active FROM allowance_receipts').get().active,0);
    db.close();
    chmodSync(file,0o644);
    const denied=spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.equal(denied.status,1);
    assert.equal(denied.stdout,'');
  } finally {rmSync(directory,{recursive:true,force:true});}
});
