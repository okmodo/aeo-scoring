// Offline frozen-state export/replay helpers. No network or live providers.
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'rolldown';
import {Miniflare,convertV4MiniflareOptions} from '../../../backend/node_modules/miniflare/dist/src/index.js';
import {createSnapshotStore} from '../../../backend/snapshot-store.mjs';
import {createBrowserContentWorkflow} from '../../../backend/browser-content-workflow.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
export async function createNativeBridge(){
 const temp=await mkdtemp(path.join(tmpdir(),'aeo-preprocessing-exit-'));
 const entry=path.join(temp,'worker.mjs'),bundle=path.join(temp,'bundle.mjs');
 await writeFile(entry,`import {preprocessHtml} from ${JSON.stringify(path.join(root,'backend/html-preprocessing.mjs'))};\nimport {extract} from ${JSON.stringify(path.join(root,'backend/retrieval.mjs'))};\nexport default {async fetch(request){const input=await request.json();if(input.operation==='preprocess'){const result=await preprocessHtml(input.args,{now:()=>input.now});return Response.json({html:[...result.html],preprocessing:result.preprocessing});}return Response.json(await extract({...input.args,body:new TextEncoder().encode(input.args.body)}));}};`);
 await build({input:entry,platform:'neutral',output:{file:bundle,format:'esm',minify:true}});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:await readFile(bundle,'utf8'),compatibilityDate:'2026-11-05',cf:false}));
 return{async call(operation,args,now){const body=operation==='preprocess'?{...args,rawHtml:new TextDecoder().decode(args.rawHtml)}:{...args,body:new TextDecoder().decode(args.body)};const response=await mf.dispatchFetch('http://local.test/',{method:'POST',body:JSON.stringify({operation,args:body,now})});if(!response.ok)throw Error('Native fixture failed');const result=await response.json();return operation==='preprocess'?{...result,html:Uint8Array.from(result.html)}:result;},async close(){await mf.dispose();await rm(temp,{recursive:true,force:true});}};
}
export function restoreFixture(data){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(path.join(root,'backend/schema.sql'),'utf8'));
 if(data.row){const keys=Object.keys(data.row);if(!keys.every(k=>/^[a-z_]+$/.test(k)))throw Error('Invalid fixture column');sqlite.prepare('INSERT INTO retained_snapshots ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>data.row[k]));}
 const objects=new Map((data.objects||[]).map(([key,value])=>[key,new Uint8Array(Buffer.from(value,'base64'))]));
 let clock=data.now;
 const db={prepare(sql){return{bind(...args){const stmt=sqlite.prepare(sql);return{first:async()=>stmt.get(...args)??null,all:async()=>({results:stmt.all(...args)}),run:async()=>({meta:{changes:Number(stmt.run(...args).changes)}})};}};}};
 const snapshots=createSnapshotStore({db,now:()=>clock,bucket:{put:async(k,v)=>objects.set(k,v.slice()),get:async k=>{const v=objects.get(k);return v&&{size:v.length,body:new Response(v).body};},delete:async keys=>keys.forEach(k=>objects.delete(k))},allowance:{reserve:async()=>({accepted:true,duplicate:false}),settle:async()=>({accepted:true})}});
 return{sqlite,db,objects,snapshots,now:()=>clock,setNow:value=>{clock=value;}};
}
async function main(){
 const now=Date.UTC(2026,10,20,12),id='d9428888-122b-4c77-8d11-666666666666',url='https://fixture.example.test/product';
 const fixture=restoreFixture({now});
 const rawHtml=new TextEncoder().encode(await readFile(path.join(root,'backend/fixtures/html-preprocessing/preservation.html'),'utf8'));
 await fixture.snapshots.preserve({auditId:id,snapshot:{url,submittedUrl:url,status:200,contentType:'text/html',observedAt:new Date(now).toISOString(),htmlLimited:null,retrievalMethod:'browser_api_content',representation:'rendered_html',captureVersion:'browser-content-v2'},extracted:{pending:true},rawHtml});
 const native=await createNativeBridge();
 try{
  const flow=createBrowserContentWorkflow({db:fixture.db,snapshots:fixture.snapshots,binding:{quickAction:()=>{throw Error('No retrieval allowed');}},guard:{},now:fixture.now,preprocess:args=>native.call('preprocess',args,now),extractPage:()=>{throw Error('EXIT_BOUNDARY_AFTER_PREPARED');}});
  try{await flow.read(id);throw Error('Boundary not reached');}catch(error){if(error.message!=='EXIT_BOUNDARY_AFTER_PREPARED')throw error;}
  const row=fixture.sqlite.prepare('SELECT * FROM retained_snapshots WHERE audit_id=?').get(id);
  if(row.prepared_state!=='ready'||row.inputs_state!==null)throw Error('Wrong export boundary');
  const artifact=await fixture.snapshots.readAssessment(id,'prepared');
  const exported={version:1,scenario:'prepared-artifact-ready-before-input-extraction',description:'Frozen synthetic data; fresh continuation must reuse prepared R2 and never retrieve or preprocess again.',now,audit:{id,url,createdAt:now,expiresAt:row.expires_at},row,objects:[...fixture.objects].map(([key,value])=>[key,Buffer.from(value).toString('base64')]),expected:{outputSha256:artifact.preprocessing.outputSha256,outputBytes:artifact.preprocessing.outputBytes,sourceSha256:row.html_hash},resume:{helper:'exit-helper.mjs',required:['restoreFixture exported state','create workflow with preprocessing/retrieval throwing if invoked','resume flow.read with native extraction','verify cleaned hash, original preserved, inputs ready','verify tampered and expired exports fail closed']}};
  await writeFile(new URL('./exit-export.json',import.meta.url),JSON.stringify(exported,null,2)+'\n');
  console.log(JSON.stringify({exported:true,boundary:exported.scenario,objects:fixture.objects.size,sourceBytes:row.html_size,preparedBytes:artifact.preprocessing.outputBytes}));
 }finally{await native.close();fixture.sqlite.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
