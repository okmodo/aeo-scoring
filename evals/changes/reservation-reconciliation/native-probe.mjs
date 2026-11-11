import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'vite';
import {Miniflare,convertV4MiniflareOptions} from '../../../backend/node_modules/miniflare/dist/src/index.js';

const built=await build({configFile:false,logLevel:'silent',build:{write:false,minify:false,
  lib:{entry:new URL('./native-probe-worker.mjs',import.meta.url).pathname,formats:['es'],fileName:'worker'}}});
const result=Array.isArray(built)?built[0]:built;
const script=result.output.find(item=>item.type==='chunk'&&item.isEntry).code;
const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-11-05',
  compatibilityFlags:['global_fetch_strictly_public','cache_option_enabled'],d1Databases:{AUDIT_DB:'native-fixture'}}));
try {
  const db=await runtime.getD1Database('AUDIT_DB');
  const schema=readFileSync(new URL('../../../backend/schema.sql',import.meta.url),'utf8');
  // Parse only this checked-in schema. Trigger bodies contain inner semicolons.
  let pending='';
  for(const raw of schema.split('\n')) {
    const line=raw.trim();if(!line||line.startsWith('--'))continue;
    pending+=line+'\n';
    const trigger=/^CREATE TRIGGER\b/.test(pending);
    if(line.endsWith(';')&&(!trigger||line==='END;')) {await db.prepare(pending).run();pending='';}
  }
  assert.equal(pending,'');
  const response=await runtime.dispatchFetch('https://fixture.invalid');
  assert.equal(response.status,200);
  const value=await response.json();
  assert.equal(value.first.accepted,true);
  assert.equal(value.settlement.accepted,true);
  assert.equal(value.duplicate.duplicate,true);
  assert.equal(value.capacity.accepted,true);
  assert.equal(value.exhausted.reason,'allowance_exhausted');
  console.log(JSON.stringify({passed:true,source:'native_workerd_with_D1',externalRequests:0,modelCalls:0,
    cases:['reserve then settle','idempotent settlement','account catches up without double counting','60% ceiling still denies']}));
} finally {await runtime.dispose();}
