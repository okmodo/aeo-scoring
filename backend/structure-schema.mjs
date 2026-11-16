// Revised S2 checks inspect markup relationships, not agreement with displayed content.
const contexts = new Set(['https://schema.org', 'https://schema.org/', 'http://schema.org', 'http://schema.org/']);
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => Object.hasOwn(v, k);
const text = v => typeof v === 'string' && v.trim().length > 0;
const type = (v, name) => [v?.['@type']].flat().some(t => [name, `https://schema.org/${name}`, `http://schema.org/${name}`].includes(t));
const norm = v => String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const sameUrl = (a, b) => { try { const x = new URL(a, b), y = new URL(b); x.hash = ''; y.hash = ''; return x.href === y.href; } catch { return false; } };
const currencies = new Set(Intl.supportedValuesOf('currency'));
const states = new Set(['InStock', 'OutOfStock', 'PreOrder', 'PreSale', 'BackOrder', 'Discontinued', 'InStoreOnly', 'OnlineOnly', 'LimitedAvailability', 'SoldOut']);
const price = v => typeof v === 'number' ? Number.isFinite(v) && v >= 0 : typeof v === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v);
const unknown = reason => ({ status: 'not_measured', reason });
const evidenceValue = value => {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  return String(rendered ?? value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
};
const gtin = (v, length) => {
  if (typeof v !== 'string' || !/^\d+$/.test(v) || ![8,12,13,14].includes(v.length) || (length && v.length !== length)) return false;
  const d = [...v].map(Number), check = d.pop();
  return (10 - d.reverse().reduce((s, n, i) => s + n * (i % 2 ? 1 : 3), 0) % 10) % 10 === check;
};
const knownProperties = new Set(['@context','@type','@id','name','description','image','url','brand','sku','mpn','gtin','gtin8','gtin12','gtin13','gtin14','offers','color','size','material','pattern','variesBy','hasVariant','isVariantOf','productGroupID','inProductGroupWithID','model','additionalProperty','aggregateRating','review','weight','height','width','depth','category']);
const supportedValue = (key, value) => {
  if (!knownProperties.has(key)) return true;
  const gtinLengths = { gtin: 0, gtin8: 8, gtin12: 12, gtin13: 13, gtin14: 14 };
  if (own(gtinLengths, key)) return gtin(value, gtinLengths[key]);
  if (key === 'url') { try { return text(value) && ['http:', 'https:'].includes(new URL(value, 'https://example.invalid').protocol); } catch { return false; } }
  if (['name', 'description', 'sku', 'mpn', 'color', 'size', 'material', 'pattern'].includes(key)) return text(value);
  if (key === 'brand') return text(value) || (obj(value) && text(value.name));
  if (key === 'offers') {
    const offers = Array.isArray(value) ? value : [value];
    return offers.length > 0 && offers.every(o => obj(o) && (!own(o, 'price') || price(o.price)) && (!own(o, 'priceCurrency') || currencies.has(o.priceCurrency)) && (!own(o, 'availability') || typeof o.availability === 'string' && states.has(o.availability.replace(/^https?:\/\/schema\.org\//, ''))));
  }
  return true;
};
function offerConnection(offer, product, source) {
  if (!obj(offer)) return 'wrong';
  if (own(offer, '@id') && !type(offer, 'Offer')) return 'unsupported';
  if (type(offer, 'AggregateOffer')) return 'unsupported';
  if (!type(offer, 'Offer')) return 'partial';
  if (own(offer, 'itemOffered')) {
    const item = offer.itemOffered;
    if (!obj(item) || (!text(item.url) && !text(item['@id']))) return 'partial';
    if (text(item['@id'])) {
      if (!text(product['@id'])) return 'unsupported';
      try { if (new URL(item['@id'], source).href !== new URL(product['@id'], source).href) return 'wrong'; }
      catch { return 'unsupported'; }
    }
    if (text(item.url) && !sameUrl(item.url, product.url ?? source)) return 'wrong';
  }
  return 'connected';
}
function offerResult(product, source, finding) {
  if (!own(product, 'offers') || product.offers == null) return finding(0, 'The associated Product has no Offer relationship.');
  const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
  if (!offers.length) return finding(0, 'The associated Product has no Offer relationship.');
  const connections = offers.map(o => offerConnection(o, product, source));
  if (connections.includes('wrong')) return finding(0, 'An Offer is malformed or connected to another Product.');
  if (connections.includes('unsupported')) return unknown('An Offer reference or aggregate requires unsupported relationship inspection.');
  if (connections.some(c => c !== 'connected')) return finding(0.5, 'The Offer connection is partly modeled or ambiguous.');
  const details = offers.map(o => {
    const hasPrice = own(o, 'price'), hasCurrency = own(o, 'priceCurrency'), hasAvailability = own(o, 'availability');
    const p = hasPrice && price(o.price), c = hasCurrency && currencies.has(o.priceCurrency);
    const a = hasAvailability && typeof o.availability === 'string' && states.has(o.availability.replace(/^https?:\/\/schema\.org\//, ''));
    const invalid = hasPrice && !p || hasCurrency && !c || hasAvailability && !a;
    return p && c && a && !invalid ? 'complete' : invalid && !p && !c && !a ? 'invalid' : 'partial';
  });
  const observedFields = offers.map(o => ['price', 'priceCurrency', 'availability'].filter(k => own(o, k)).map(k => `${k}=${evidenceValue(o[k])}`).join(', ') || 'no commercial fields').join('; ');
  if (details.every(d => d === 'invalid')) return finding(0, `Offer commercial fields are unusable: ${observedFields}.`);
  return finding(details.every(d => d === 'complete') ? 1 : 0.5, `Offer fields: ${observedFields}.`);
}
function identifierAbsenceProof(html) {
  return html?.complete === true && html.sourceObservation?.complete === true && html.sourceObservation?.regions === 1 &&
    (html.sourceObservation.blocks ?? []).some(block => typeof block.text === 'string' && /^No GTIN or MPN has been assigned to this product[.!]?$/i.test(block.text.trim()));
}
function identifierResult(product, html, finding, source) {
  const fields = [['gtin',0],['gtin8',8],['gtin12',12],['gtin13',13],['gtin14',14]];
  const supplied = fields.filter(([k]) => own(product, k));
  const valid = supplied.filter(([k,n]) => gtin(product[k], n));
  if (valid.length && new Set(valid.map(([k]) => product[k].padStart(14, '0'))).size > 1) return unknown('Multiple external identifiers cannot be reconciled.');
  const unsupportedExternal = ['asin', 'isbn', 'identifier', 'productID'].filter(k => own(product, k));
  if (identifierAbsenceProof(html) && !supplied.length && !own(product, 'mpn') && !unsupportedExternal.length) return { status: 'not_applicable', rule: 'no_identifiers_assigned', justification: 'Explicit product evidence establishes that no external identifier is assigned.', url: source, location: 'product identifier evidence', excerpt: 'No external identifier is assigned.' };
  const external = valid.length && valid.length === supplied.length || text(product.mpn) && supplied.length === 0;
  if (supplied.length && valid.length !== supplied.length || own(product, 'mpn') && !text(product.mpn)) return finding(0, `Invalid external identifier: ${[...supplied.filter(([k,n]) => !gtin(product[k], n)).map(([k]) => `${k}=${evidenceValue(product[k])}`), ...(own(product, 'mpn') && !text(product.mpn) ? [`mpn=${evidenceValue(product.mpn)}`] : [])].join(', ')}.`);
  if (unsupportedExternal.length) return unknown(`Unsupported supplied external identifier fields: ${unsupportedExternal.join(', ')}.`);
  if (external) return finding(1, 'An applicable external product identifier is supplied on the associated Product.');
  if (text(product.sku)) return finding(0.5, 'A merchant SKU is supplied; no valid external product identifier was established.');
  return unknown('Identifier applicability or assignment was not established.');
}
function singleConfigurationProof(html) {
  const observation = html?.sourceObservation;
  return html?.complete === true && observation?.complete === true && observation.regions === 1 && !observation.hasVariantControls &&
    (observation.blocks ?? []).some(block => typeof block.text === 'string' && block.text.split(/(?<=[.!?])\s+/u).some(sentence => /^(?:(?:(?:this product|this item|available in|there is|there's)\s+)?(?:only one|a single|single) configuration|this product is offered in a single configuration)[.!?]?$/i.test(sentence.trim())));
}
function variantResult(group, product, html, finding, source) {
  if (singleConfigurationProof(html) && !group && html?.hasVariantControls !== true && !(product && ['isVariantOf', 'hasVariant', 'variesBy'].some(k => own(product, k)))) return { status: 'not_applicable', rule: 'single_configuration', justification: 'Product-scoped evidence explicitly establishes a single configuration.', url: source, location: 'product configuration', excerpt: 'The product explicitly has one configuration.' };
  if (!group) {
    if (product && ['isVariantOf', 'hasVariant', 'variesBy'].some(k => own(product, k))) return finding(0.5, 'A variant relationship is supplied but its family is not fully established.');
    return html?.hasVariantControls === true ? finding(0, 'Variant controls were observed without a structured family relationship.') : unknown('Variant applicability was not established.');
  }
  const dims = (Array.isArray(group.variesBy) ? group.variesBy : [group.variesBy]).map(v => typeof v === 'string' ? v.replace(/^https?:\/\/schema\.org\//, '') : '');
  const variants = Array.isArray(group.hasVariant) ? group.hasVariant : [];
  if (variants.some(v => obj(v) && own(v, '@id') && !type(v, 'Product'))) return unknown('Variant references require unsupported graph resolution.');
  const validDims = dims.length > 0 && dims.length <= 4 && dims.every(v => ['color','size','material','pattern'].includes(v)) && new Set(dims).size === dims.length;
  const good = validDims && variants.length >= 2 && variants.length <= 8 && variants.every(v => type(v, 'Product') && dims.every(d => text(v[d])));
  const distinct = good && new Set(variants.map(v => JSON.stringify(dims.map(d => norm(v[d]))))).size === variants.length;
  return finding(distinct ? 1 : variants.length || validDims ? 0.5 : 0, `ProductGroup variesBy=${evidenceValue(group.variesBy)}; ${variants.length} variant(s) inspected${distinct ? ' with distinct attributes' : ' with incomplete or indistinct attributes'}.`);
}

export function inspectRevisedProductSchema(snapshot, extracted) {
  const html = extracted?.productHtml, source = snapshot?.url;
  const bounded = Boolean(html?.complete && !snapshot?.htmlLimited && extracted?.coverage?.jsonLdTruncated === false);
  const result = { complete: bounded, product: null, findings: {}, ambiguous: false, malformed: false };
  const finding = (fraction, excerpt) => ({ status: 'measured', fraction, url: source, location: 'inspected structured product markup', excerpt });
  const products = [], groups = [];
  let unsupported = Boolean(html?.unsupportedProductMarkup ?? html?.otherProductMarkup), observed = false, badValues = false, unknownProperties = false;
  const invalidValues = [];
  for (const script of extracted?.jsonLd ?? []) {
    observed = true;
    if (typeof script !== 'string' || script.length > 131072) { unsupported = true; continue; }
    try {
      const parsed = JSON.parse(script), inherited = parsed?.['@context'];
      const records = Array.isArray(parsed) ? parsed : [parsed, ...(Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [])];
      for (const record of records) {
        if (!obj(record)) continue;
        if (['@included','@nest','@reverse'].some(k => own(record,k))) unsupported = true;
        if (!type(record, 'Product') && !type(record, 'ProductGroup')) continue;
        if (!contexts.has(record['@context'] ?? inherited)) { unsupported = true; continue; }
        for (const [k, v] of Object.entries(record)) if (knownProperties.has(k) && !supportedValue(k, v)) { badValues = true; if (invalidValues.length < 4) invalidValues.push(`${k}=${evidenceValue(v)}`); }
        if (Object.keys(record).some(k => !knownProperties.has(k))) unknownProperties = true;
        (type(record, 'ProductGroup') ? groups : products).push(record);
      }
    } catch { result.malformed = true; }
  }
  for (const item of html?.structuredRecords ?? []) {
    observed = true;
    if (!item.complete) { unsupported = true; continue; }
    if (type(item.record, 'ProductGroup')) groups.push(item.record);
    else if (type(item.record, 'Product')) products.push(item.record);
    if (obj(item.record)) for (const [k, v] of Object.entries(item.record)) if (knownProperties.has(k) && !supportedValue(k, v)) { badValues = true; if (invalidValues.length < 4) invalidValues.push(`${k}=${evidenceValue(v)}`); }
    if (obj(item.record) && Object.keys(item.record).some(k => !knownProperties.has(k))) unknownProperties = true;
  }
  result.complete = bounded && !unsupported && !result.malformed;
  const recognized = products.length + groups.length > 0;
  if (recognized && (bounded && !unsupported && !unknownProperties || result.malformed || badValues)) result.findings['S2.syntax'] = finding(result.malformed || badValues ? 0.5 : 1, result.malformed || badValues ? `Observed ${result.malformed ? 'malformed JSON-LD' : 'invalid values'}${invalidValues.length ? `: ${invalidValues.join('; ')}` : ''}.` : 'Recognized structured markup parses with supported value formats.');
  else if (result.malformed) result.findings['S2.syntax'] = finding(0, 'Observed JSON-LD could not be parsed.');
  else if (!recognized && result.complete) result.findings['S2.syntax'] = finding(0, observed ? 'No recognized product type was found in inspected markup.' : 'No structured product markup was found.');
  if (!result.complete) return result;
  const heading = typeof html?.identity === 'string' ? html.identity : html?.identity?.mainH1 ?? html?.headings?.find(h => h.level === 1)?.text;
  const candidates = [...products];
  for (const group of groups) if (Array.isArray(group.hasVariant) && group.hasVariant.length <= 8) candidates.push(...group.hasVariant.filter(v => obj(v) && type(v, 'Product')));
  const matches = candidates.filter(p => text(p.url) ? sameUrl(p.url, source) : text(heading) && norm(p.name) === norm(heading));
  if (matches.length !== 1) {
    const wrong = candidates.length > 0 && candidates.every(p => text(p.url) && !sameUrl(p.url, source));
    result.ambiguous = !wrong && (candidates.length > 0 || groups.length > 0);
    result.findings['S2.entity'] = finding(result.ambiguous ? 0.5 : 0, result.ambiguous ? 'Product candidates could not be uniquely associated with this page.' : wrong ? `Product URLs identify a different page: ${candidates.map(p => evidenceValue(p.url)).slice(0, 4).join(', ')}.` : 'No Product was found in complete markup inspection.');
    if (!result.ambiguous) {
      result.findings['S2.offer'] = finding(0, 'No Offer associated with the audited Product was found.');
      if (html?.hasVariantControls === true) result.findings['S2.variants'] = finding(0, 'Applicable variants lack structured relationships.');
      if (singleConfigurationProof(html) && !groups.length) result.findings['S2.variants'] = variantResult(null, null, html, finding, source);
      if (!candidates.length && identifierAbsenceProof(html)) result.findings['S2.identifiers'] = identifierResult({}, html, finding, source);
    }
    return result;
  }
  const product = matches[0]; result.product = product;
  result.findings['S2.entity'] = finding(1, 'A Product is uniquely associated with the audited page.');
  result.findings['S2.offer'] = offerResult(product, source, finding);
  result.findings['S2.identifiers'] = identifierResult(product, html, finding, source);
  const group = groups.find(g => Array.isArray(g.hasVariant) && g.hasVariant.includes(product));
  result.findings['S2.variants'] = variantResult(group, product, html, finding, source);
  return result;
}
