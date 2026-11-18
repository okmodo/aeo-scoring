import test from 'node:test';
import assert from 'node:assert/strict';
import { captureBrowserProduct } from './browser-retrieval.mjs';

function fixture({requests = ['https://store.com/product'], body = '<h1>Product</h1>', closeThrows = false, redirect = false, redirectTo = null, stable = true, cookies = {}, responseHeaders = {}} = {}) {
  const calls = []; let handler;
  const guard = {reserve:async x => {calls.push(['reserve',x]);return {accepted:true,duplicate:false}},startLaunch:async x=>{calls.push(['start',x]);return {accepted:true,duplicate:false}},bindSession:async x=>{calls.push(['bind',x]);return {accepted:true}},settle:async x=>{calls.push(['settle',x]);return {accepted:true}}};
  const frame = {}; let current;
  const page = {mainFrame:()=>frame,on(){}, async goto(url) {
    current=url; calls.push(['goto',url]);
    const entries = [url, ...requests.slice(1)];
    for (const [index, target] of entries.entries()) {
      let aborted = false;
      await handler({request:()=>({url:()=>target,method:()=> 'GET',isNavigationRequest:()=>index===0,resourceType:()=> index===0 ? 'document' : 'script',allHeaders:async()=>({cookie:cookies[new URL(target).hostname] || ''}),frame:()=>frame}),fulfill:async x=>{calls.push(['fulfill',x.body.length,x.headers])},abort:async()=>{aborted=true}});
      if (aborted && index===0) throw new Error('navigation aborted');
    }
    return {ok:()=>true};
  }, waitForTimeout:async()=>{}, evaluate:async fn=>fn.name==='waitForProductStability' ? {stable} : ({renderedHtml:'<h1>Rendered</h1>',extracted:{productHtml:{},coverage:{}},selectedVariant:[],expanded:0}),url:()=>current};
  const context = {cookies:async url=>cookies[new URL(url).hostname] ? [{name:'session',value:cookies[new URL(url).hostname].split('=')[1]}] : [],addInitScript:async()=>{},routeWebSocket:async()=>{},route:async(_,fn)=>{handler=fn},newPage:async()=>page};
  const browser = {sessionId:()=> 'session',newContext:async()=>context,close:async()=>{calls.push(['close']);if(closeThrows)throw Error('lost')}};
  const egress = {fetch:async(target, options)=>{calls.push(['fetch',target,options]);return (redirect || (redirectTo && target===requests[0])) ? new Response(null,{status:302,headers:{...responseHeaders,location:redirectTo || 'http://127.0.0.1/private'}}) : new Response(body,{status:200,headers:responseHeaders})}};
  return {calls,guard,egress,launch:async()=>browser,binding:{},id:'test',supportInspector:async snapshot=>snapshot};
}

test('one navigation captures initial and rendered evidence and closes before settlement', async()=>{
  const f=fixture(); const result=await captureBrowserProduct('https://store.com/product',f);
  assert.equal(new TextDecoder().decode(result.initialHtml),'<h1>Product</h1>');
  assert.equal(result.renderedHtml,'<h1>Rendered</h1>');
  assert.deepEqual(f.calls.map(x=>x[0]),['reserve','start','bind','goto','fetch','fulfill','close','settle']);
});

test('unstable product content is reported incomplete',async()=>{
  const f=fixture({stable:false});
  const result=await captureBrowserProduct('https://store.com/product',f);
  assert.equal(result.extracted.productHtml.complete,false);
  assert.equal(result.coverage.stable,false);
});

test('subresources use public egress and private destinations are blocked',async()=>{
  const good=fixture({requests:['https://store.com/product','https://cdn.com/app.js']});
  await captureBrowserProduct('https://store.com/product',good);
  assert.deepEqual(good.calls.filter(x=>x[0]==='fetch').map(x=>x[1]),['https://store.com/product','https://cdn.com/app.js']);
  const bad=fixture({requests:['https://store.com/product','http://127.0.0.1/private.js']});
  await assert.rejects(captureBrowserProduct('https://store.com/product',bad));
  assert.equal(bad.calls.filter(x=>x[0]==='fetch').length,1);
});

test('subresource redirects are not fulfilled and make rendered coverage incomplete',async()=>{
  const f=fixture({requests:['https://store.com/product','https://cdn.com/app.js']});
  const original=f.egress.fetch;
  f.egress.fetch=async (target,options)=>target==='https://cdn.com/app.js' ? new Response(null,{status:302,headers:{location:'https://cdn.com/new.js'}}) : original(target,options);
  const result=await captureBrowserProduct('https://store.com/product',f);
  assert.equal(result.coverage.subresourceLimited,true);
  assert.equal(result.extracted.productHtml.complete,false);
  assert.equal(f.calls.filter(x=>x[0]==='fulfill').length,1);
});

test('browser cookies stay scoped and support metadata is attached',async()=>{
  const f=fixture({requests:['https://store.com/product','https://cdn.com/app.js'],cookies:{'store.com':'session=first','cdn.com':'session=cdn'}});
  f.supportInspector=async (snapshot,{fetchBounded,signal})=>{
    await fetchBounded(new URL('https://store.com/robots.txt'),signal);
    return {...snapshot,crawlerPolicy:{version:1},sitemap:{state:'read'},guides:{state:'unknown'},policies:{}};
  };
  const result=await captureBrowserProduct('https://store.com/product',f);
  const calls=f.calls.filter(x=>x[0]==='fetch');
  assert.deepEqual(calls.map(x=>[x[1],x[2].browserHeaders.cookie]),[
    ['https://store.com/product','session=first'],['https://cdn.com/app.js','session=cdn'],['https://store.com/robots.txt','session=first']]);
  assert.deepEqual(result.support.crawlerPolicy,{version:1});
  assert.deepEqual(result.support.policies,{});
});

test('separate Set-Cookie headers retain separate values for Chromium',async()=>{
  const headers = new Headers();
  headers.append('set-cookie','session=one; Path=/; HttpOnly');
  headers.append('set-cookie','theme=dark; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT');
  const f=fixture({responseHeaders:headers});
  await captureBrowserProduct('https://store.com/product',f);
  assert.equal(f.calls.find(x=>x[0]==='fulfill')[2]['set-cookie'],'session=one; Path=/; HttpOnly\ntheme=dark; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT');
});

test('redirect cannot escape interception to a private address',async()=>{
  const f=fixture({redirect:true});
  await assert.rejects(captureBrowserProduct('https://store.com/product',f));
  assert.equal(f.calls.filter(x=>x[0]==='fetch').length,1);
  assert.equal(f.calls.some(x=>x[0]==='fulfill'),false);
  assert.ok(f.calls.some(x=>x[0]==='close'));
});

test('redirects that set cookies fail closed before another navigation',async()=>{
  const f=fixture({redirectTo:'https://shop.com/final',responseHeaders:{'set-cookie':'session=one; Path=/'}});
  await assert.rejects(captureBrowserProduct('https://store.com/product',f));
  assert.equal(f.calls.filter(x=>x[0]==='goto').length,1);
});

test('public redirects are aborted and vetted before navigating to final product',async()=>{
  const f=fixture({redirectTo:'https://shop.com/final'});
  const result=await captureBrowserProduct('https://store.com/product',f);
  assert.equal(result.url,'https://shop.com/final');
  assert.deepEqual(f.calls.filter(x=>x[0]==='goto').map(x=>x[1]),['https://store.com/product','https://shop.com/final']);
  assert.deepEqual(f.calls.filter(x=>x[0]==='fetch').map(x=>x[1]),['https://store.com/product','https://shop.com/final']);
  assert.equal(f.calls.filter(x=>x[0]==='fulfill').length,1);
});

test('initial response is rendered in full and retained as a bounded prefix',async()=>{
  const f=fixture({body:'x'.repeat(1024*1024+1)});
  const result=await captureBrowserProduct('https://store.com/product',f);
  assert.equal(result.initialLimited,true);
  assert.equal(result.initialHtml.byteLength,1024*1024);
  assert.equal(f.calls.find(x=>x[0]==='fulfill')[1],1024*1024+1);
});

test('initial response exceeding the render bound fails closed',async()=>{
  const f=fixture({body:'x'.repeat(4*1024*1024+1)});
  await assert.rejects(captureBrowserProduct('https://store.com/product',f));
  assert.ok(f.calls.some(x=>x[0]==='close'));
});

test('failed close retains the reservation',async()=>{
  const f=fixture({closeThrows:true}); await assert.rejects(captureBrowserProduct('https://store.com/product',f));
  assert.equal(f.calls.some(x=>x[0]==='settle'),false);
});

test('late launch binds and closes without visiting the page',async()=>{
  const f=fixture(); const launch=f.launch; let release;
  f.launch=()=>new Promise(resolve=>{release=async()=>resolve(await launch());});
  const capture=captureBrowserProduct('https://store.com/product',{...f,sessionTimeoutMs:10});
  await assert.rejects(capture,/timeout/);
  await release();
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(f.calls.some(x=>x[0]==='bind'));
  assert.ok(f.calls.some(x=>x[0]==='close'));
  assert.equal(f.calls.some(x=>x[0]==='goto'),false);
});

test('hung closure returns promptly and retains the hold',async()=>{
  const f=fixture(); const launch=f.launch;
  f.launch=async()=>({...await launch(),close:()=>new Promise(()=>{})});
  await assert.rejects(captureBrowserProduct('https://store.com/product',{...f,closeTimeoutMs:10}),/closure unconfirmed/);
  assert.equal(f.calls.some(x=>x[0]==='settle'),false);
});

test('binding provider only confirms closure from a valid finished session', async()=>{
  const {createBrowserProvider} = await import('./browser-retrieval.mjs');
  const start = 1_800_000_000_000;
  const binding = {closeSession:async()=>({status:'closing'})};
  const sdk = {sessions:async()=>[{sessionId:'active'}],history:async()=>[{sessionId:'ours',startTime:start,endTime:start+120}]};
  const provider = createBrowserProvider(binding,{sdk,clock:()=>start+200,confirmationTimeoutMs:20,retryMs:2});
  assert.equal((await provider.listSessions()).length,1);
  assert.equal((await provider.verifyClosed({sessionId:'ours',now:start+200})).durationMs,120);
  assert.equal((await provider.closeOwnedSession('ours')).status,'closing');
  sdk.history = async()=>[];
  await assert.rejects(provider.verifyClosed({sessionId:'ours',now:start+200}));
});

test('closure timestamp is checked against a clock sampled after history returns',async()=>{
  const {createBrowserProvider} = await import('./browser-retrieval.mjs');
  const start=1_800_000_000_000; let time=start+100;
  const sdk={history:async()=>{time=start+210;return [{sessionId:'s',startTime:start,endTime:start+200}];}};
  const provider=createBrowserProvider({closeSession:async()=>({status:'closed'})},{sdk,clock:()=>time});
  assert.deepEqual(await provider.verifyClosed({sessionId:'s',now:start+100}),{sessionId:'s',closed:true,durationMs:200,observedAt:start+210});
});

test('missing history is retried within one deadline, then confirmed with fresh time',async()=>{
  const {createBrowserProvider} = await import('./browser-retrieval.mjs');
  const start=1_800_000_000_000;let calls=0;
  const sdk={history:async()=>++calls===1 ? [] : [{sessionId:'s',startTime:start,endTime:start+10}]};
  const provider=createBrowserProvider({closeSession:async()=>({status:'closed'})},{sdk,clock:()=>start+20,confirmationTimeoutMs:100,retryMs:2});
  assert.equal((await provider.verifyClosed({sessionId:'s'})).durationMs,10);
  assert.equal(calls,2);
});

test('malformed, duplicate and future closure records are not retried',async()=>{
  const {createBrowserProvider} = await import('./browser-retrieval.mjs');
  const start=1_800_000_000_000;
  for (const data of [null,[{sessionId:'s',startTime:start,endTime:'bad'}],[{sessionId:'s',startTime:start,endTime:start+30}],[{sessionId:'s',startTime:start,endTime:start+10},{sessionId:'s',startTime:start,endTime:start+10}]]) {
    let calls=0;const sdk={history:async()=>{calls++;return data}};
    const provider=createBrowserProvider({closeSession:async()=>({status:'closed'})},{sdk,clock:()=>start+20,confirmationTimeoutMs:100,retryMs:2});
    await assert.rejects(provider.verifyClosed({sessionId:'s'}));
    assert.equal(calls,1);
  }
});

test('history timeout and visibility retries share a bounded deadline',async()=>{
  const {createBrowserProvider} = await import('./browser-retrieval.mjs');
  let calls=0; const sdk={history:async()=>{calls++;return new Promise(()=>{})}};
  const provider=createBrowserProvider({closeSession:async()=>({status:'closed'})},{sdk,confirmationTimeoutMs:20,retryMs:2});
  await assert.rejects(provider.verifyClosed({sessionId:'s'}),/timeout/);
  assert.equal(calls,1);
});

test('capture error survives failed closure with only a sanitized cleanup code',async()=>{
  const f=fixture();const launch=f.launch;const original=new Error('capture fixture failed');
  f.launch=async()=>({...await launch(),newContext:async()=>{throw original},close:async()=>{throw new Error('merchant-secret')}});
  await assert.rejects(captureBrowserProduct('https://store.com/product',f),error=>error===original && error.cleanupCode==='browser_close_unconfirmed' && !JSON.stringify(error).includes('merchant-secret'));
  assert.equal(f.calls.some(x=>x[0]==='settle'),false);
});

test('capture failure is preserved if settlement throws',async()=>{
  const f=fixture();const launch=f.launch;const original=new Error('capture fixture failed');
  f.launch=async()=>({...await launch(),newContext:async()=>{throw original}});
  f.guard.settle=async()=>{throw new Error('sensitive settlement details')};
  await assert.rejects(captureBrowserProduct('https://store.com/product',f),error=>error===original && error.cleanupCode==='browser_settlement_unconfirmed' && !JSON.stringify(error).includes('sensitive'));
});
