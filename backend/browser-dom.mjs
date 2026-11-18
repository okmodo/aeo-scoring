// Serialized by Playwright: parsing, visibility checks and extraction run remotely.
export function captureProductDom({initialHtml, initialLimited = false}) {
  const excluded = 'nav,footer,header,aside,script,style,[hidden],[inert],[aria-hidden="true"],product-recommendations,related-products,[class*="recommend" i],[id*="recommend" i],[class*="related-product" i],[data-section-type*="related" i]';
  const initial = new DOMParser().parseFromString(initialHtml, 'text/html');
  const collect = (doc, rendered, limited) => {
    const roots = [...doc.querySelectorAll('main,[role="main"]')].filter(el => !el.closest(excluded));
    const root = roots[0] || doc.body;
    const visible = el => {
      if (el.closest(excluded)) return false;
      for (let node = el; node; node = node.parentElement) if (/(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))/i.test(node.getAttribute('style') || '')) return false;
      if (!rendered) return true;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
    };
    const nodes = root ? [...root.querySelectorAll('*')] : [];
    let complete = !limited && roots.length === 1 && nodes.length <= 10000;
    let sourceComplete = complete;
    const blocks = [], headings = [], images = [], links = [], selectedControls = [], priceCandidates = [], inlineSupport = [];
    let controls = 0, unselectedControls = 0, informationalImages = 0, deferredContent = 0;
    for (const [index, el] of nodes.slice(0,10000).entries()) {
      if (!visible(el)) continue;
      const location = `${rendered ? 'rendered' : 'initial'}:element:${index + 1}`;
      const tag = el.tagName.toLowerCase();
      const text = ((rendered ? el.innerText : el.textContent) || '').trim().replace(/\s+/g,' ');
      if (text.length > 4000) { complete = false; sourceComplete = false; }
      const valueText = text.slice(0,4000);
      if (/^h[1-6]$/.test(tag) && text) {
        headings.push({text:valueText,level:Number(tag[1]),location});
        if (/^h[2-6]$/.test(tag) && /\b(?:shipping|delivery|returns?|refunds?|polic(?:y|ies)|guides?|size charts?|specifications?|manuals?|instructions?|warrant(?:y|ies))\b/i.test(text)) {
          let next = el.nextElementSibling, readable = false;
          while (next && !/^H[1-6]$/.test(next.tagName)) { if (visible(next) && next.textContent.trim()) readable = true; next = next.nextElementSibling; }
          inlineSupport.push({title:valueText,id:el.id || el.parentElement?.id || null,readable,location});
        }
      }
      const leafBlock = /^(div|span)$/.test(tag) && !el.querySelector('div,span,p,li,dt,dd,blockquote,h1,h2,h3,h4,h5,h6') && !el.parentElement?.closest('p,li,dt,dd,blockquote');
      if ((/^(p|li|dt|dd|blockquote)$/.test(tag) || leafBlock) && text) blocks.push({text:valueText,location});
      if (tag === 'img') { const alt=el.getAttribute('alt') || ''; images.push({alt,location}); if (/\b(?:specifications?|size chart|sizing chart|product details|ingredients|dimensions)\b/i.test(alt)) informationalImages++; }
      if (tag === 'a' && el.getAttribute('href') && text) links.push({url:el.getAttribute('href'),text:valueText,location});
      const variant = /\b(?:size|colou?r|width|variant|configuration|attribute|option|model)\b/i.test(`${el.name || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-product-attribute') || ''}`);
      if ((tag === 'select' || (tag === 'input' && /radio|checkbox/i.test(el.type))) && variant) {
        controls++;
        let value = null;
        if (tag === 'select') {
          const chosen = [...el.querySelectorAll('option[selected]:not([disabled])')];
          if (rendered) value = el.value;
          else if (chosen.length === 1 && !el.hasAttribute('multiple') && !el.hasAttribute('disabled')) value = chosen[0].getAttribute('value') || chosen[0].textContent.trim();
        } else if (el.hasAttribute('checked') && !el.hasAttribute('disabled')) value = el.value || el.getAttribute('value');
        if (value != null) selectedControls.push({name:el.name || null,value,type:tag === 'select' ? 'select' : el.type,location}); else unselectedControls++;
      }
      if (el.hasAttribute('data-product-price-without-tax') || el.hasAttribute('data-product-non-sale-price-without-tax')) {
        const amount = Number(text.replace(/[^0-9.]/g,''));
        if (Number.isFinite(amount) && text) priceCandidates.push({amount,role:el.hasAttribute('data-product-non-sale-price-without-tax')?'previous':'current',location});
      }
      if (/(?:^|[\s_-])(?:deferred-product-content|product-content-on-interaction)(?:$|[\s_-])/i.test(`${el.id || ''} ${el.className || ''}`)) deferredContent++;
      if (blocks.length + headings.length + images.length + links.length > 1500) { complete = false; sourceComplete = false; break; }
    }
    const jsonLd = []; let jsonSize = 0; let jsonLdTruncated = false;
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      if (script.closest('aside,product-recommendations,related-products,[class*="recommend" i],[class*="related-product" i]')) continue;
      const value = script.textContent.trim(); jsonSize += value.length;
      if (jsonLd.length >= 20 || jsonSize > 100000) { jsonLdTruncated = true; break; }
      if (value) jsonLd.push(value);
    }
    const opaqueScripts = [...doc.querySelectorAll('script[type="application/json"]')].filter(el=>/product|variant/i.test(el.id || '')).length;
    const hasProductMicrodata = !!root && (root.matches('[itemscope][itemtype*="schema.org/Product"], [typeof*="Product"]') || !!root.querySelector('[itemscope][itemtype*="schema.org/Product"], [typeof*="Product"]'));
    const identity = {title:doc.title || null,mainH1:headings.find(x=>x.level===1)?.text || null};
    if (!identity.mainH1) complete = false;
    if (root?.querySelector('[aria-expanded="false"], [role="radio"], [role="listbox"]')) { sourceComplete = false; complete = false; }
    if (root?.querySelector('[data-product-recommendations], [itemref]')) sourceComplete = false;
    const observation = {complete:sourceComplete,regions:roots.length,productImages:images.length,opaqueScripts,controls,unselectedControls,informationalImages,deferredContent,inlineSupport,blocks,headings,links,selectedControls,hasVariantControls:controls>0};
    const productHtml = {complete,blocks,headings,images,links,identity,visibility:rendered?'computed':'unknown',discoveryLinks:links,otherProductMarkup:!!doc.querySelector('product-recommendations,related-products,[class*="recommend" i],[class*="related-product" i]'),selectedControls,priceCandidates,hasVariantControls:controls>0,singleConfiguration:null,structuredRecords:[],unsupportedProductMarkup:hasProductMicrodata,platform:null,sourceObservation:observation};
    return {productHtml,jsonLd,coverage:{html:complete,jsonLdTruncated}};
  };
  const selected = () => JSON.stringify([...document.querySelectorAll('main select,main input:checked')].map(el=>[el.name,el.value]));
  const before = selected(); let expanded = 0;
  for (const details of document.querySelectorAll('main details:not([open])')) {
    if (expanded >= 8 || details.closest(excluded)) continue;
    const summary = details.querySelector(':scope > summary');
    if (summary && /details|description|material|fabric|specification|care|features|size|shipping|delivery|return/i.test(summary.textContent)) { details.open = true; expanded++; }
  }
  if (selected() !== before) throw new Error('selected variant changed');
  const initialExtracted = collect(initial,false,initialLimited);
  const extracted = collect(document,true,false);
  const bytes = new TextEncoder().encode(document.documentElement.outerHTML);
  const renderedLimited = bytes.length > 1024 * 1024;
  const renderedHtml = new TextDecoder().decode(bytes.subarray(0,renderedLimited ? 1024 * 1024 - 3 : bytes.length));
  if (new TextEncoder().encode(JSON.stringify({initialExtracted,extracted})).length > 256 * 1024) throw new Error('extracted data too large');
  return {initialExtracted,renderedHtml,renderedLimited,extracted,selectedVariant:extracted.productHtml.selectedControls,expanded};
}

// Runs in the browser. The overall capture deadline remains the outer bound.
export async function waitForProductStability({maxMs = 3000, stableMs = 500, intervalMs = 100} = {}) {
  const started = performance.now();
  let previous = ''; let unchangedSince = started;
  while (performance.now() - started < maxMs) {
    const root = document.querySelector('main,[role="main"]');
    const text = root ? [...root.querySelectorAll('h1,h2,h3,p,li,dt,dd')].filter(el=>!el.closest('aside,nav,footer,header,[hidden],[aria-hidden="true"],product-recommendations,related-products,[class*="recommend" i],[class*="related-product" i]') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0).map(el=>el.innerText || '').join(' ').trim().replace(/\s+/g,' ').slice(0,12000) : '';
    const controls = root ? [...root.querySelectorAll('select,input:checked,[aria-checked="true"],[aria-selected="true"]')].slice(0,100).map(el=>[el.name || el.getAttribute('aria-label') || '',el.value || el.textContent.trim().slice(0,200)]) : [];
    const state = text ? JSON.stringify([text,controls]) : '';
    const now = performance.now();
    if (!state || state !== previous) { previous = state; unchangedSince = now; }
    else if (now - unchangedSince >= stableMs) return {stable:true};
    await new Promise(resolve => setTimeout(resolve,intervalMs));
  }
  return {stable:false};
}
