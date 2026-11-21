import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';
test('native private RPC continues after the submitting HTTP response closes',async()=>{
 const{Miniflare,convertV4MiniflareOptions}=await import(process.env.MINIFLARE_MODULE||'miniflare');
 const source=await readFile(new URL('./public-worker.mjs',import.meta.url),'utf8');
 const entry=source.slice(source.indexOf('export class AuditContinuation'),source.indexOf('\nconst egress'));
 const script=`import{WorkerEntrypoint}from'cloudflare:workers';let calls=0;const runPreparation=async({onPrepared})=>{await onPrepared('11111111-1111-4111-8111-111111111111')};const runPreparedAudit=async()=>{await new Promise(r=>setTimeout(r,20));calls++;return{status:calls<12?'yield':'completed'}};${entry}\nexport default{async fetch(request,env){if(new URL(request.url).pathname==='/start'){await env.AUDIT_SELF.prepare('11111111-1111-4111-8111-111111111111');return new Response('accepted',{status:202})}return Response.json({calls})}};`;
 const mf=new Miniflare(convertV4MiniflareOptions({name:'prepared-rpc',modules:true,script,compatibilityDate:'2026-11-05',cf:false,serviceBindings:{AUDIT_SELF:{name:'prepared-rpc',entrypoint:'AuditContinuation'}}}));
 try{const response=await mf.dispatchFetch('http://localhost/start');assert.equal(response.status,202);await response.text();let state;const end=Date.now()+4000;do{state=await(await mf.dispatchFetch('http://localhost/status')).json();if(state.calls>=12)break;await new Promise(r=>setTimeout(r,20));}while(Date.now()<end);assert.equal(state.calls,12);await new Promise(r=>setTimeout(r,50));assert.equal((await(await mf.dispatchFetch('http://localhost/status')).json()).calls,12);}finally{await mf.dispose();}
});
