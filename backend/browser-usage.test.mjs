import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_CYCLE_LIMIT_MS, BROWSER_CONCURRENCY_LIMIT, collectBrowserUsage } from './browser-usage.mjs';

test('browser limits are 60 percent and absent usage is not zero', async () => {
  assert.equal(BROWSER_CYCLE_LIMIT_MS, 21_600_000);
  assert.equal(BROWSER_CONCURRENCY_LIMIT, 6);
  await assert.rejects(collectBrowserUsage(), /invalid_browser_configuration/);
});

test('collects a conservative all-session count and 31-day duration estimate', async () => {
  const now=Date.parse('2026-11-17T12:00:00Z'), accountId='a'.repeat(32);
  const fetch = async (url,options) => {
    if (url.endsWith('/subscriptions')) return Response.json({success:true,errors:[],result:[{id:'sub',current_period_start:'2026-11-01T00:00:00Z',current_period_end:'2026-12-01T00:00:00Z'}]});
    if (url.endsWith('/devtools/session')) return Response.json([{sessionId:'active'}]);
    const query=JSON.parse(options.body).query;
    if (query.includes('browserRenderingBrowserTimeUsageAdaptiveGroups')) {
      assert.ok(query.includes('2026-10-17T12:00:00.000Z'));
      return Response.json({data:{viewer:{accounts:[{time:[{count:5,sum:{totalSessionDurationMs:3856}}],peak:[]}]}}});
    }
    return Response.json({data:{viewer:{accounts:[{workers:[],d1:[],storage:[],ai:[]}]}}});
  };
  const result=await collectBrowserUsage({accountId,subscriptionId:'sub',token:'t',now,fetch});
  assert.equal(result.usageMs,3856); assert.equal(result.concurrencyUnits,39); assert.equal(result.complete,true);
  const injected=await collectBrowserUsage({accountId,subscriptionId:'sub',token:'t',now,fetch,listSessions:async()=>[]});
  assert.equal(injected.concurrencyUnits,11);
  await assert.rejects(collectBrowserUsage({accountId,subscriptionId:'sub',token:'t',now,fetch,listSessions:async()=>[{}]}));
  await assert.rejects(collectBrowserUsage({accountId,subscriptionId:'sub',token:'t',now,fetch:async (url,options)=>url.endsWith('/devtools/session') ? new Response('',{status:403}) : fetch(url,options)}));
});
