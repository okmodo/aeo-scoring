import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import http from 'node:http';

test('native workerd reads Queue analytics and denies redirected requests', {timeout:60000}, async () => {
  const {Miniflare,convertV4MiniflareOptions}=await import(process.env.MINIFLARE_MODULE || 'miniflare');
  const calls=[];
  const now=Date.UTC(2026,10,22);
  const server=http.createServer((request,response)=>{
    calls.push({path:request.url,authorization:request.headers.authorization});
    if(request.url==='/redirect/subscriptions') {
      response.writeHead(302,{location:'/unexpected'});
      response.end();
      return;
    }
    const payload=request.url==='/success/subscriptions'
      ? {success:true,errors:[],result:[{id:'fixture',current_period_start:new Date(now-86400000).toISOString(),current_period_end:new Date(now+86400000).toISOString()}]}
      : {data:{viewer:{accounts:[{queueMessageOperationsAdaptiveGroups:[{sum:{billableOperations:42}}]}]}}};
    response.writeHead(200,{'content-type':'application/json'});
    response.end(JSON.stringify(payload));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const loopback=`http://127.0.0.1:${server.address().port}`;
  let mf;
  try {
    const collector=(await readFile(new URL('./audit-queue-allowance.mjs',import.meta.url),'utf8')).replace(/^export /gm,'');
    const script=`${collector}
      export default {async fetch(request) {
        const route=new URL(request.url).pathname;
        try {
          const result=await collectAuditQueueUsage({
            accountId:'a'.repeat(32),subscriptionId:'fixture',token:'fixture-token',now:${now},
            fetch:(url,options)=>fetch(${JSON.stringify(loopback)}+route+(url.endsWith('/graphql')?'/graphql':'/subscriptions'),options)
          });
          return Response.json({operations:result.operations});
        } catch(error) {
          return Response.json({error:error.message},{status:503});
        }
      }};`;
    mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-11-05',cf:false}));
    const success=await mf.dispatchFetch('http://localhost/success');
    const data=await success.json();
    assert.equal(success.status,200,JSON.stringify(data));
    assert.deepEqual(data,{operations:42});
    const denied=await mf.dispatchFetch('http://localhost/redirect');
    assert.equal(denied.status,503);
    assert.deepEqual(await denied.json(),{error:'unavailable'});
    assert.deepEqual(calls.map(call=>call.path),['/success/subscriptions','/success/graphql','/redirect/subscriptions']);
    assert.ok(calls.every(call=>call.authorization==='Bearer fixture-token'));
  } finally {
    await mf?.dispose();
    await new Promise(resolve=>server.close(resolve));
  }
});
