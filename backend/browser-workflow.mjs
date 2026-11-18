import { captureBrowserProduct, createBrowserProvider } from './browser-retrieval.mjs';
import { createBrowserAllowanceGuard, BROWSER_CONTROLS_VERSION } from './browser-allowance.mjs';

export const BROWSER_RETRIEVAL_VERSION = 'browser-product-v1';
export const BROWSER_RESERVATION_MS = 3_720_000;

export function createBrowserWorkflow({db,binding,snapshots,egress,accountId,subscriptionId,token,now=Date.now,
  provider=createBrowserProvider(binding),guard=createBrowserAllowanceGuard(db,{accountId,subscriptionId,token,
    listSessions:()=>provider.listSessions(),verifyClosed:request=>provider.verifyClosed(request),
    capability:{version:BROWSER_CONTROLS_VERSION,maxDurationMs:BROWSER_RESERVATION_MS,cleanupAfterMs:20000}}),
  capture=captureBrowserProduct} = {}) {
  return {
    async prepare(audit) {
      const id = 'browser-' + audit.id;
      const grant = await guard.reserve({id,maxDurationMs:BROWSER_RESERVATION_MS,now:now()});
      if (!grant?.accepted || grant.duplicate !== false) return {accepted:false,reason:grant?.reason};
      try {
        await db.prepare("INSERT INTO browser_audit_work VALUES (?1,'capturing',?2,?3)").bind(audit.id,now(),Math.min(audit.createdAt+120000,audit.expiresAt)).run();
      } catch (error) {
        await guard.cancelUnstarted?.({id,now:now()});
        throw error;
      }
      return {accepted:true,id};
    },
    async capture(audit,grant,pipeline) {
      let consumed = false;
      const leasedGuard = {
        ...guard,
        reserve:async request=>{
          if (consumed || request.id!==grant.id || request.maxDurationMs!==BROWSER_RESERVATION_MS) return {accepted:false,reason:'invalid_grant'};
          consumed = true;
          return {accepted:true,duplicate:false};
        },
      };
      const result = await capture(audit.url,{binding,egress,guard:leasedGuard,id:grant.id,now});
      const snapshot = {url:result.url,status:200,contentType:'text/html',observedAt:result.observedAt,
        retrievalMethod:'browser',htmlLimited:result.coverage?.initialLimited ? 'bytes' : null,
        crawlerPolicy:result.support?.crawlerPolicy, sitemap:result.support?.sitemap,
        guides:result.support?.guides, policies:result.support?.policies,
        browser:{version:BROWSER_RETRIEVAL_VERSION,initialExtracted:result.initialExtracted,
          renderedHtml:result.renderedHtml,selectedVariant:result.selectedVariant,coverage:result.coverage}};
      await pipeline?.record('retrieval','completed','browser_captured');
      await snapshots.preserve({auditId:audit.id,snapshot,extracted:result.extracted,rawHtml:result.initialHtml});
      await pipeline?.record('snapshot','completed','browser_snapshot_retained');
      const ready = await db.prepare("UPDATE browser_audit_work SET state='ready' WHERE audit_id=?1 AND state='capturing' AND expires_at>?2").bind(audit.id,now()).run();
      if (ready.meta.changes!==1) throw new Error('Browser capture lease expired');
    },
    async claim(id) {
      return Boolean(await db.prepare("UPDATE browser_audit_work SET state='assessing' WHERE audit_id=?1 AND state='ready' AND expires_at>?2 RETURNING audit_id").bind(id,now()).first());
    },
    read:id=>snapshots.read(id),
    async finish(id) {await db.prepare("UPDATE browser_audit_work SET state='finished' WHERE audit_id=?1").bind(id).run();},
    watchdog:()=>guard.watchdog({now:now(),closeOwnedSession:sessionId=>provider.closeOwnedSession(sessionId)}),
  };
}
