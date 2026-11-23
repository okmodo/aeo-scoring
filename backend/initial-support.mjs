import {normalizePublicTarget} from './public-egress.mjs';
import {extract} from './retrieval.mjs';
import {inspectBrowserSupport} from './browser-support.mjs';

const normalized = value => typeof value === 'string' ? value.trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US') : '';
export function matchesInitialProduct(initial, rendered, url) {
  const a = initial?.productHtml, b = rendered?.productHtml;
  const uniqueHeading = product => {
    const values = (product?.headings || []).filter(item=>item.level===1).map(item=>normalized(item.text)).filter(Boolean);
    const distinct = [...new Set(values)];
    return distinct.length === 1 ? distinct[0] : distinct.length === 0 ? normalized(product?.identity?.mainH1) : '';
  };
  const heading = uniqueHeading(a);
  if (!heading || heading !== uniqueHeading(b) ||
      /(?:just a moment|access denied|verify you are human|security check|captcha|challenge)/i.test(heading) ||
      initial?.coverage?.html !== true || rendered?.coverage?.html !== true ||
      initial?.coverage?.usable !== true || rendered?.coverage?.usable !== true ||
      initial?.coverage?.jsonLdTruncated !== false || rendered?.coverage?.jsonLdTruncated !== false) return false;
  try {
    const target = normalizePublicTarget(url);
    const matchesCanonical = value => typeof value === 'string' && value.length > 0 &&
      normalizePublicTarget(new URL(value, url).toString()) === target;
    return matchesCanonical(initial.canonical) && matchesCanonical(rendered.canonical);
  } catch { return false; }
}

async function withAbort(pending, signal) {
  if (signal.aborted) throw new Error('aborted');
  let abort;
  const aborted = new Promise((_,reject)=>{ abort=()=>reject(new Error('aborted')); signal.addEventListener('abort',abort,{once:true}); });
  try { return await Promise.race([pending,aborted]); }
  finally { signal.removeEventListener('abort',abort); }
}

// Optional independent HTTP observations; the browser remains the product capture.
// One shared deadline and the 2 MiB initial response limit bound this pass.
export async function gatherInitialSupport(snapshot, renderedExtracted, {egress, HTMLRewriter} = {}) {
  if (!egress?.fetch || !HTMLRewriter) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const fetchBounded = async (url, signal) => {
    const combined = AbortSignal.any([controller.signal, signal]);
    if (combined.aborted) throw new Error('aborted');
    const pending = Promise.resolve(egress.fetch(url.toString(), {method:'GET',redirect:'manual',signal:combined}));
    pending.then(response => { if (combined.aborted) void response.body?.cancel().catch(()=>{}); },()=>{});
    return await withAbort(pending, combined);
  };
  try {
    const url = normalizePublicTarget(snapshot.url);
    let initialExtracted = null;
    try {
      const response = await fetchBounded(new URL(url), controller.signal);
      if (response.status !== 200 || response.headers.has('content-range') || !/^text\/html(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '') || !response.body) {
        void response.body?.cancel().catch(()=>{});
      } else {
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          while (true) {
            const part = await withAbort(reader.read(), controller.signal);
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 2 * 1024 * 1024) throw new Error('initial response too large');
            chunks.push(part.value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
          const candidate = await extract({url,body:bytes,htmlLimited:null}, {HTMLRewriter});
          if (matchesInitialProduct(candidate,renderedExtracted,url)) initialExtracted = candidate;
        } finally { void reader.cancel().catch(()=>{}); }
      }
    } catch { /* unavailable initial evidence */ }
    const supportSnapshot = {url,extracted:renderedExtracted};
    try { await inspectBrowserSupport(supportSnapshot,{fetchBounded,signal:controller.signal,HTMLRewriter}); } catch { /* optional */ }
    const {crawlerPolicy,sitemap,guides,policies} = supportSnapshot;
    return {initialExtracted,support:{crawlerPolicy,sitemap,guides,policies}};
  } catch { return null; }
  finally { clearTimeout(timer); controller.abort(); }
}
