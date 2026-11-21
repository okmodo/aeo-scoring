import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('native workerd rejects redirect error and sends one manual request', {timeout: 60000}, async()=>{
 const {Miniflare,convertV4MiniflareOptions}=await import(process.env.MINIFLARE_MODULE || 'miniflare');
 let calls=0;
 const server=http.createServer((_request,response)=>{calls++;response.writeHead(302,{location:'http://127.0.0.1:1/external'});response.end('ignored');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}/`;
 const script=`export default {async fetch(request) { const url=${JSON.stringify(url)}; if(new URL(request.url).pathname==='/old') { try { await fetch(url,{redirect:'error'}); return Response.json({threw:false}); } catch(e) { return Response.json({threw:e instanceof TypeError}); } } const response=await fetch(url,{redirect:'manual'}); await response.body?.cancel(); return Response.json({status:response.status}); }};`;
 let mf;
 try {
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-11-05',cf:false}));
  assert.deepEqual(await (await mf.dispatchFetch('http://localhost/old')).json(),{threw:true});
  assert.equal(calls,0);
  assert.deepEqual(await (await mf.dispatchFetch('http://localhost/new')).json(),{status:302});
  assert.equal(calls,1);
 } finally { if(mf) await mf.dispose(); await new Promise(resolve=>server.close(resolve)); }
});
