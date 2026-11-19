import test from 'node:test';
import assert from 'node:assert/strict';
import {collectQuickActionUsage} from './quick-action-usage.mjs';
const now=1_700_000_000_000, accountId='a'.repeat(32);
function fetcher(browserRows=[]) { return async (url,options) => {
 if(url.endsWith('/subscriptions')) return Response.json({success:true,errors:[],result:[{id:'s',current_period_start:new Date(now-86400000).toISOString(),current_period_end:new Date(now+29*86400000).toISOString()}]});
 const query=JSON.parse(options.body).query;
 return Response.json({data:{viewer:{accounts:[query.includes('browserRenderingBrowserTimeUsageAdaptiveGroups')?{time:browserRows}:{workers:[],d1:[],storage:[],ai:[]}]}}});
}; }
test('collects rolling browser milliseconds without listing sessions',async()=>{
 const r=await collectQuickActionUsage({accountId,subscriptionId:'s',token:'secret',now,fetch:fetcher([{sum:{totalSessionDurationMs:1.2}}])}); assert.equal(r.usageMs,2); assert.equal(r.complete,true);
});
test('rejects malformed browser totals',async()=>{await assert.rejects(collectQuickActionUsage({accountId,subscriptionId:'s',token:'secret',now,fetch:fetcher([{sum:{totalSessionDurationMs:-1}}])}));});
