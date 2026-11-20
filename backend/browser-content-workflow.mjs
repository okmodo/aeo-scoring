import {normalizePublicTarget} from './public-egress.mjs';
import {extract} from './retrieval.mjs';
import {createQuickActionAllowanceGuard,QUICK_ACTION_HOLD_MS} from './quick-action-allowance.mjs';
import {MAX_RENDERED_HTML_BYTES} from './snapshot-store.mjs';
import {preprocessHtml,MAX_CLEANED_HTML_BYTES} from './html-preprocessing.mjs';

export const BROWSER_CONTENT_VERSION = 'browser-content-v3';
const CAPTURE_VERSION = 'browser-content-v2';
const encoder = new TextEncoder();
const emptyExtraction = () => ({productHtml:null,jsonLd:[],coverage:{html:false,usable:false,jsonLdTruncated:true}});
const failure = (code,diagnosticCode) => Object.assign(new Error('Browser content capture unavailable'),{code,diagnosticCode});
async function responseJson(response,signal) {
  if (!response?.body?.getReader) throw failure('retrieval_failed','browser_api_invalid_response');
  const reader=response.body.getReader(),chunks=[];let size=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try {
    for (;;) {const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
      if(size>2*MAX_RENDERED_HTML_BYTES)throw failure('response_too_large','browser_api_response_too_large');chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
    if(signal.aborted)throw failure('retrieval_timeout','browser_api_timeout');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  } catch(error) { if(error.code)throw error;throw failure('retrieval_failed','browser_api_invalid_response'); }
  finally {signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});}
}

// Capture is one provider request followed by private R2 persistence. No browser
// session, page routing, resource proxy, cookie handling or HTML extraction here.
export function createBrowserContentWorkflow({db,binding,snapshots,accountId,subscriptionId,token,now=Date.now,
  guard=createQuickActionAllowanceGuard(db,{accountId,subscriptionId,token}),extractPage=extract,
  HTMLRewriter=globalThis.HTMLRewriter,preprocess=preprocessHtml,captureTimeoutMs=28000}={}) {
  if(typeof binding?.quickAction!=='function'||!snapshots||!db?.prepare||!Number.isSafeInteger(captureTimeoutMs)||captureTimeoutMs<1||captureTimeoutMs>28000)throw new TypeError('Browser content binding and private store required');
  return {
    version:BROWSER_CONTENT_VERSION,
    async prepare(audit) {
      const id='content-'+audit.id;
      const grant=await guard.reserve({id,maxDurationMs:QUICK_ACTION_HOLD_MS,now:now()});
      if(!grant?.accepted||grant.duplicate!==false)return{accepted:false,reason:grant?.reason};
      try {await db.prepare("INSERT INTO browser_audit_work VALUES (?1,'capturing',?2,?3)").bind(audit.id,now(),Math.min(audit.createdAt+120000,audit.expiresAt)).run();}
      catch(error){await guard.cancelUnstarted({id,now:now()});throw error;}
      return{accepted:true,id};
    },
    async capture(audit,grant,pipeline) {
      if(!grant?.accepted||grant.id!=='content-'+audit.id)throw failure('retrieval_failed','browser_api_invalid_grant');
      const target=normalizePublicTarget(audit.url);
      const started=await guard.start({id:grant.id,now:now()});
      if(!started?.accepted||started.duplicate)throw failure('retrieval_failed','browser_api_start_denied');
      let response,timer;const controller=new AbortController();
      const work=(async()=>{
        response=await binding.quickAction('content',{
          url:target,
        });
        // A response proves provider-reported usage even if its body or storage
        // later fails. A missing usage header leaves the original hold intact.
        await guard.settle({id:grant.id,response,now:now()});
        if(controller.signal.aborted){await response.body?.cancel().catch(()=>{});throw failure('retrieval_timeout','browser_api_timeout');}
        const value=await responseJson(response,controller.signal);
        if(!response.ok||value?.success!==true||typeof value.result!=='string')throw failure('retrieval_failed','browser_api_provider_failed');
        if(!value.result.trim())throw failure('retrieval_failed','browser_api_empty_html');
        const html=encoder.encode(value.result);
        if(html.byteLength>MAX_RENDERED_HTML_BYTES)throw failure('response_too_large','browser_api_response_too_large');
        const meta=value.meta;
        if(!meta||typeof meta!=='object'||!Number.isInteger(meta.status)||meta.status<100||meta.status>599||typeof meta.finalUrl!=='string')throw failure('retrieval_failed','browser_api_invalid_metadata');
        const url=normalizePublicTarget(meta.finalUrl);
        return{html,snapshot:{url,submittedUrl:audit.url,status:meta.status,contentType:'text/html',observedAt:new Date(now()).toISOString(),htmlLimited:null,
          retrievalMethod:'browser_api_content',representation:'rendered_html',captureVersion:CAPTURE_VERSION,
          provider:{name:'cloudflare-browser-content',httpStatus:response.status,originStatus:meta.status,title:typeof meta.title==='string'?meta.title.slice(0,1000):null,
            browserMsUsed:response.headers.get('X-Browser-Ms-Used')}}};
      })();
      let result;
      try {result=await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failure('retrieval_timeout','browser_api_timeout'));},captureTimeoutMs);})]);}
      finally {clearTimeout(timer);}
      await pipeline?.record('retrieval','completed','browser_api_captured');
      await snapshots.preserve({auditId:audit.id,snapshot:result.snapshot,extracted:{pending:true},rawHtml:result.html});
      await pipeline?.record('snapshot','completed','browser_content_stored');
      // Keep even an origin error page available as evidence, but do not grade it.
      if(result.snapshot.status<200||result.snapshot.status>=300)throw failure('retrieval_failed','browser_api_origin_http_error');
      const ready=await db.prepare("UPDATE browser_audit_work SET state='ready', expires_at=?3 WHERE audit_id=?1 AND state='capturing' AND expires_at>?2").bind(audit.id,now(),audit.expiresAt).run();
      if(ready.meta.changes!==1)throw failure('assessment_timeout','browser_api_lease_expired');
    },
    async claimPreparation(id){return await db.prepare("UPDATE browser_audit_work SET state='assessing', expires_at=MIN(?2+30000,(SELECT expires_at FROM retained_snapshots WHERE audit_id=?1)) WHERE audit_id=?1 AND (state='ready' OR (state='assessing' AND expires_at<=?2)) AND EXISTS (SELECT 1 FROM retained_snapshots WHERE audit_id=?1 AND state='ready' AND expires_at>?2) RETURNING expires_at").bind(id,now()).first();},
    async claim(id){return Boolean(await this.claimPreparation(id));},
    async release(id,grant){await db.prepare("UPDATE browser_audit_work SET state='ready', expires_at=(SELECT expires_at FROM retained_snapshots WHERE audit_id=?1) WHERE audit_id=?1 AND state='assessing' AND expires_at=?2 AND expires_at>?3").bind(id,grant.expires_at,now()).run();},
    async read(id, {onPrepared} = {}) {
      const captured=await snapshots.read(id);
      if(captured.snapshot?.retrievalMethod!=='browser_api_content')throw failure('retrieval_failed','browser_api_invalid_snapshot');
      const state=await db.prepare('SELECT inputs_state, prepared_state FROM retained_snapshots WHERE audit_id=?1').bind(id).first();
      if(!state)throw failure('retrieval_failed','browser_api_invalid_snapshot');
      if(state.prepared_state===null) {
        const result=await preprocess({rawHtml:captured.rawHtml,sourceObjectKey:captured.source.objectKey,expiresAt:captured.source.expiresAt},{HTMLRewriter,now});
        const html=new TextDecoder('utf-8',{fatal:true}).decode(result.html);
        try {await snapshots.saveAssessment({auditId:id,kind:'prepared',artifact:{version:'1',html,preprocessing:result.preprocessing}});}
        catch(error) {if(error.code!=='snapshot_exists')throw error;}
      }
      const prepared=await snapshots.readAssessment(id,'prepared');
      const p=prepared?.preprocessing, bytes=encoder.encode(prepared?.html ?? '');
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
      if(prepared?.version!=='1'||typeof prepared.html!=='string'||bytes.byteLength>MAX_CLEANED_HTML_BYTES||
        p?.version!=='simplified-html-v1'||p.representation!=='cleaned_rendered_html'||p.originalCapturePreserved!==true||
        p.sourceObjectKey!==captured.source.objectKey||p.sourceSha256!==captured.source.sha256||p.sourceBytes!==captured.source.bytes||
        p.expiresAt!==captured.source.expiresAt||!Number.isSafeInteger(p.preparedAt)||p.preparedAt<0||p.preparedAt>=p.expiresAt||p.outputBytes!==bytes.byteLength||p.outputSha256!==hash)throw failure('retrieval_failed','browser_api_invalid_prepared');
      // Ready publication is sufficient for the independent AI consumer;
      // optional extraction below must not gate or roll back that notification.
      if (onPrepared) { try { await onPrepared(id); } catch { /* Maintenance retries missed notifications. */ } }
      if(state.inputs_state===null) {
        const extracted=await extractPage({...captured.snapshot,body:bytes},{HTMLRewriter});
        // Parsed rendered HTML cannot establish initial-response or computed-visibility evidence.
        const snapshot={...captured.snapshot,preprocessing:p,browser:{version:BROWSER_CONTENT_VERSION,captureType:'content-api',initialExtracted:emptyExtraction(),
          coverage:{complete:extracted.productHtml?.complete===true&&extracted.coverage?.html===true,initialAvailable:false,initialLimited:false,renderedLimited:false}}};
        try {await snapshots.saveAssessment({auditId:id,kind:'inputs',artifact:{version:'2',snapshot,extracted}});}
        catch(error) {if(error.code!=='snapshot_exists')throw error;}
      }
      const inputs=await snapshots.readAssessment(id,'inputs');
      if(inputs?.version!=='2'||inputs.snapshot?.captureVersion!==captured.snapshot.captureVersion||inputs.snapshot?.url!==captured.snapshot.url||
        JSON.stringify(inputs.snapshot?.preprocessing)!==JSON.stringify(p)||inputs.snapshot?.browser?.version!==BROWSER_CONTENT_VERSION||
        !inputs.extracted||inputs.snapshot?.browser?.coverage?.initialAvailable!==false)throw failure('retrieval_failed','browser_api_invalid_inputs');
      return{...captured,rawHtml:bytes,snapshot:{...inputs.snapshot,browser:{...inputs.snapshot.browser,renderedHtml:prepared.html}},extracted:inputs.extracted};
    },
    async finish(id,grant){if(grant) await db.prepare("UPDATE browser_audit_work SET state='finished' WHERE audit_id=?1 AND state='assessing' AND expires_at=?2 AND expires_at>?3").bind(id,grant.expires_at,now()).run();
      else await db.prepare("UPDATE browser_audit_work SET state='finished' WHERE audit_id=?1").bind(id).run();},
  };
}
