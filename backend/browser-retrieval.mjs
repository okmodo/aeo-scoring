import { Buffer } from 'node:buffer';
import { inspectBrowserSupport } from './browser-support.mjs';
import { captureProductDom, waitForProductStability } from './browser-dom.mjs';
import { normalizePublicTarget } from './public-egress.mjs';

const MAX_DOCUMENT = 1024 * 1024;
const MAX_RESOURCE = 4 * 1024 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;
const SESSION_MS = 20_000;
const RESERVATION_MS = 3_720_000;

async function boundedBody(response, max) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > max) throw new Error('response too large');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new Error('response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

// The supplied egress must be the strictly-public Worker transport; no browser
// request is allowed to continue directly to the browser's network stack.
export async function captureBrowserProduct(input, { binding, egress, guard, id, launch, supportInspector = inspectBrowserSupport, now = Date.now, sessionTimeoutMs = SESSION_MS, closeTimeoutMs = 2000 } = {}) {
  const url = normalizePublicTarget(input);
  if (!binding || !egress?.fetch || !guard || !id || !Number.isSafeInteger(sessionTimeoutMs) || sessionTimeoutMs < 1 || sessionTimeoutMs > SESSION_MS || !Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 2000) throw new TypeError('Browser, public egress, usage guard, and bounded timeouts required');
  const reservation = await guard.reserve({id, maxDurationMs: RESERVATION_MS, now: now()});
  if (!reservation?.accepted || reservation.duplicate) throw new Error('browser admission denied');
  let browser; let sessionId; let sessionBound = false; let closeConfirmed = false; let closePromise; let timeout;
  const close = () => {
    if (!browser) return Promise.resolve();
    closePromise ||= (async () => {
      let timer;
      try { await Promise.race([browser.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('close timeout')), closeTimeoutMs); })]); closeConfirmed = true; }
      catch { /* Unknown closure retains the reservation. */ }
      finally { clearTimeout(timer); }
    })();
    return closePromise;
  };
  const controller = new AbortController();
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('browser capture timeout')); }, sessionTimeoutMs); });
  try {
    const work = (async () => {
      const create = launch || (await import('@cloudflare/playwright')).launch;
      if (controller.signal.aborted) throw new Error('browser capture timeout');
      const started = await guard.startLaunch({id, now:now()});
      if (!started?.accepted || started.duplicate) throw new Error('browser launch denied');
      if (controller.signal.aborted) throw new Error('browser capture timeout');
      browser = await create(binding, { keep_alive: 10_000 });
      sessionId = browser.sessionId();
      if (!sessionId) throw new Error('missing browser session ID');
      let bound;
      try { bound = await guard.bindSession({id, sessionId}); }
      finally { if (controller.signal.aborted) await close(); }
      if (!bound?.accepted) throw new Error('browser session could not be recorded');
      sessionBound = true;
      if (controller.signal.aborted) { await close(); if (closeConfirmed) await guard.settle({id, now:now()}); }
      if (controller.signal.aborted) throw new Error('browser capture timeout');
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
      await context.routeWebSocket('**/*', ws => ws.close());
      await context.addInitScript(() => {
        for (const key of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','WebTransport']) {
          try { Object.defineProperty(globalThis, key, {value:undefined, configurable:false, writable:false}); } catch {}
        }
      });
      let count = 0; let total = 0; let initial; let routeError; let page; let pendingRedirect; let subresourceLimited = false;
      await context.route('**/*', async route => {
        try {
          const request = route.request();
          const target = normalizePublicTarget(request.url());
          if (controller.signal.aborted || ++count > 100 || request.method() !== 'GET') throw new Error('request blocked');
          const isDocument = request.isNavigationRequest() && request.resourceType() === 'document';
          if (isDocument && request.frame() !== page.mainFrame()) throw new Error('frame navigation blocked');
          const browserHeaders = await request.allHeaders();
          const response = await egress.fetch(target, {method:'GET', redirect:'manual', browserHeaders, signal:controller.signal});
          // Playwright does not route subsequent requests in a redirect chain. Never
          // give Chromium a 3xx that it could follow outside the egress boundary.
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (isDocument) {
              // The aborted redirect cannot install its cookies in Chromium.
              if (response.headers.has('set-cookie')) throw new Error('redirect cookies unsupported');
              if (!location || /[\\\x00-\x20\x7f]/.test(location)) throw new Error('invalid redirect location');
              pendingRedirect = normalizePublicTarget(new URL(location, target).toString());
            } else subresourceLimited = true;
            await route.abort();
            return;
          }
          const body = await boundedBody(response, MAX_RESOURCE);
          total += body.byteLength;
          if (total > MAX_TOTAL) throw new Error('resource budget exceeded');
          const headers = Object.fromEntries(response.headers);
          if (headers['set-cookie']) {
            if (typeof response.headers.getSetCookie !== 'function') throw new Error('cannot safely split cookies');
            const cookies = response.headers.getSetCookie();
            if (!cookies.length || cookies.some(value => /[\r\n]/.test(value))) throw new Error('invalid cookie headers');
            headers['set-cookie'] = cookies.join('\n');
          }
          delete headers['content-encoding']; delete headers['content-length']; delete headers['transfer-encoding'];
          if (isDocument && response.status >= 200 && response.status < 300) initial = {url:target, body, status:response.status, limited:body.byteLength > MAX_DOCUMENT};
          await route.fulfill({ status: response.status, headers, body:Buffer.from(body) });
        } catch (error) { routeError ||= error; await route.abort().catch(() => {}); }
      });
      page = await context.newPage();
      page.on('popup', popup => { void popup.close(); });
      let response; let current = url; const visited = new Set();
      for (let hops = 0; ; hops++) {
        if (controller.signal.aborted || visited.has(current)) throw new Error('invalid redirect chain');
        visited.add(current); pendingRedirect = undefined;
        try { response = await page.goto(current, {waitUntil:'domcontentloaded', timeout: 12_000}); }
        catch (error) { if (!pendingRedirect) throw error; }
        if (!pendingRedirect) break;
        if (hops >= 3) throw new Error('too many redirects');
        current = pendingRedirect;
      }
      if (!response || !response.ok() || !initial || initial.status !== 200 || routeError) throw routeError || new Error('document unavailable');
      const stability = await page.evaluate(waitForProductStability);
      const dom = await page.evaluate(captureProductDom, {initialHtml:new TextDecoder().decode(initial.body), initialLimited:initial.limited});
      if (subresourceLimited || !stability?.stable) { dom.extracted.productHtml.complete = false; dom.extracted.coverage.html = false; }
      if (routeError || !initial || page.url() !== initial.url) throw routeError || new Error('unexpected navigation');
      const supportSnapshot = {url:initial.url, extracted:dom.extracted};
      const fetchBounded = async (target, requestSignal) => {
        if (controller.signal.aborted || requestSignal.aborted || ++count > 100) throw new Error('support budget exhausted');
        const cookies = await context.cookies(target.toString());
        const cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ');
        const response = await egress.fetch(target.toString(), {method:'GET', redirect:'manual', browserHeaders:{cookie}, signal:AbortSignal.any([controller.signal,requestSignal])});
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('support redirect blocked'); }
        const body = await boundedBody(response, MAX_RESOURCE);
        total += body.byteLength;
        if (total > MAX_TOTAL) throw new Error('support budget exhausted');
        const headers = new Headers(response.headers);
        headers.delete('content-encoding'); headers.delete('content-length'); headers.delete('transfer-encoding');
        return new Response([204,205,304].includes(response.status) ? null : body, {status:response.status,headers});
      };
      const inspected = await supportInspector(supportSnapshot, {fetchBounded,signal:controller.signal});
      const support = {crawlerPolicy:inspected.crawlerPolicy,sitemap:inspected.sitemap,guides:inspected.guides,policies:inspected.policies};
      if (controller.signal.aborted) throw new Error('browser capture timeout');
      return {support,url:initial.url, observedAt:new Date(now()).toISOString(), initialHtml:initial.body.slice(0, MAX_DOCUMENT), initialLimited:initial.limited, renderedHtml:dom.renderedHtml, initialExtracted:dom.initialExtracted, extracted:dom.extracted, selectedVariant:dom.selectedVariant, coverage:{expanded:dom.expanded, complete:dom.extracted.coverage?.html === true, initialLimited:initial.limited, renderedLimited:dom.renderedLimited, subresourceLimited, stable:stability?.stable === true}};
    })().finally(async () => { if (controller.signal.aborted) await close(); });
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timeout); controller.abort();
    await close();
    if (browser && !closeConfirmed) throw new Error('browser closure unconfirmed');
    if (sessionBound && closeConfirmed) {
      const settled = await guard.settle({id, now:now()});
      if (!settled?.accepted) throw new Error('browser closure or usage unconfirmed');
    }
  }
}

async function providerTimeout(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new Error('browser provider timeout')),5000); })]); }
  finally { clearTimeout(timer); }
}

// The caller must only pass closeOwnedSession IDs loaded from its own lease.
export function createBrowserProvider(binding, { sdk } = {}) {
  if (!binding || typeof binding.closeSession !== 'function') throw new TypeError('Browser session binding required');
  const api = async () => sdk || await import('@cloudflare/playwright');
  return {
    async launch(options) { return (await api()).launch(binding, options); },
    async listSessions() {
      const sessions = await providerTimeout((await api()).sessions(binding));
      if (!Array.isArray(sessions)) throw new Error('invalid browser sessions');
      return sessions;
    },
    async verifyClosed({sessionId, now = Date.now()}) {
      const history = await providerTimeout((await api()).history(binding));
      if (!Array.isArray(history)) throw new Error('browser closure unknown');
      const matches = history.filter(item => item?.sessionId === sessionId);
      if (matches.length !== 1) throw new Error('browser closure unknown');
      const session = matches[0];
      if (!Number.isSafeInteger(session.startTime) || !Number.isSafeInteger(session.endTime) || session.startTime < 1_000_000_000_000 || session.endTime < session.startTime || session.endTime > now) throw new Error('browser closure unknown');
      return {sessionId, closed:true, durationMs:session.endTime-session.startTime, observedAt:now};
    },
    async closeOwnedSession(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('session ID required');
      const result = await providerTimeout(binding.closeSession(sessionId));
      const status = typeof result === 'string' ? result : result?.status;
      if (status !== 'closing' && status !== 'closed') throw new Error('browser closure unknown');
      return result;
    },
  };
}
