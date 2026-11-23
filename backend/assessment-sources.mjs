import { inspectProductSchema } from './structure-assessment.mjs';

// Complete retained inputs, split without silently selecting a product vocabulary.
// These are untrusted documents, including scripts and recommendations.
export const ASSESSMENT_SOURCE_VERSION = '1';
export const SECTION_BYTES = 8 * 1024;
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' && !(value instanceof Uint8Array) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export async function prepareAssessmentSources(snapshot, extracted) {
  if (!snapshot || !extracted || typeof snapshot.url !== 'string') throw new TypeError('Invalid retained inputs');
  const raw = snapshot.rawHtml;
  if (!(raw instanceof Uint8Array) && typeof raw !== 'string') throw new TypeError('Missing retained HTML');
  const rawBytes = typeof raw === 'string' ? encoder.encode(raw) : raw;
  const renderedOnly = snapshot.retrievalMethod === 'browser_api_content';
  if (rawBytes.length > (renderedOnly ? 8 : 1) * 1024 * 1024) throw new RangeError('Retained HTML exceeds limit');
  // Reject undecodable bytes instead of replacing them and claiming full inspection.
  const html = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  // A verified preprocessing artifact is the model input, not the parser's
  // bounded excerpts. The original response remains separate source evidence.
  const preparedHtml = renderedOnly && snapshot.preprocessing !== undefined;
  if (preparedHtml) {
    const p = snapshot.preprocessing;
    if (!p || p.version !== 'simplified-html-v1' || p.representation !== 'cleaned_rendered_html' ||
        p.originalCapturePreserved !== true || !/^[a-f0-9]{64}$/.test(p.sourceSha256 || '') ||
        typeof p.sourceObjectKey !== 'string' || !/^retained\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/html$/.test(p.sourceObjectKey) ||
        !Number.isSafeInteger(p.sourceBytes) || p.sourceBytes < 1 || p.sourceBytes > 8 * 1024 * 1024 ||
        p.outputBytes !== rawBytes.length || p.outputSha256 !== await hash(rawBytes))
      throw new TypeError('Invalid retained cleaned HTML provenance');
  }
  const { rawHtml, extracted: ignoredExtracted, body, ...metadata } = snapshot;
  const browser = snapshot.browser;
  let renderedHtml, initialExtracted, browserMetadata, supportMetadata;
  if (browser !== undefined) {
    if (!browser || typeof browser !== 'object' || Array.isArray(browser) || typeof browser.renderedHtml !== 'string' ||
        !browser.initialExtracted || typeof browser.initialExtracted !== 'object' || Array.isArray(browser.initialExtracted) ||
        !browser.coverage || typeof browser.coverage !== 'object') throw new TypeError('Invalid retained browser capture');
    renderedHtml = browser.renderedHtml;
    if (encoder.encode(renderedHtml).length > (renderedOnly ? 8 : 1) * 1024 * 1024) throw new RangeError('Rendered HTML exceeds limit');
    initialExtracted = browser.initialExtracted;
    // A separate initial-response observation can inform deterministic checks.
    // The prepared document and model product sources still describe rendered HTML.
    const separateObservation = preparedHtml && browser.coverage.initialAvailable === true &&
      browser.coverage.initialLimited === false && initialExtracted.coverage?.html === true;
    if (renderedOnly && (renderedHtml !== html || !(browser.coverage.initialAvailable === false || separateObservation)))
      throw new TypeError('Invalid rendered-only browser capture');
    const {initialExtracted: ignoredInitial, renderedHtml: ignoredRendered, ...rest} = browser;
    browserMetadata = rest;
    delete metadata.browser;
    supportMetadata = {};
    for (const key of ['crawlerPolicy','sitemap','guides','policies']) {
      if (Object.hasOwn(metadata,key)) { supportMetadata[key] = metadata[key]; delete metadata[key]; }
    }
  }
  if (renderedOnly && browser === undefined) throw new TypeError('Invalid rendered-only browser capture');
  let documents = [
    { kind: 'html', scope: 'product', location: preparedHtml ? 'cleaned rendered HTML; visibility unknown' : renderedOnly ? 'captured rendered HTML' : 'captured initial HTML', text: html },
    { kind: 'metadata', scope: 'metadata', location: 'retained retrieval metadata and supporting observations', text: JSON.stringify(canonical(metadata)) },
    { kind: 'extracted', scope: 'extracted', location: 'complete retained extraction', text: JSON.stringify(canonical(extracted)) },
  ];
  if (preparedHtml) documents = documents.filter(document => document.kind !== 'extracted');
  if (browser !== undefined) {
    // Each source has explicit provenance so initial-document checks can exclude
    // rendered content while content checks can inspect the complete capture.
    documents[0].origin = renderedOnly ? 'rendered' : 'initial';
    documents[1].origin = 'shared';
    if (!preparedHtml) documents[2].origin = 'rendered';
    else documents[0].preparedHtml = true;
    const associated = renderedOnly ? null : inspectProductSchema(snapshot,initialExtracted);
    if (associated && associated.complete && !associated.ambiguous && !associated.malformed && associated.product && !snapshot.htmlLimited && browser.coverage.initialLimited === false) {
      documents.push({kind:'structured_product',scope:'product',location:'associated initial Product schema',text:JSON.stringify(canonical(associated.product)),origin:'initial'});
    }
    if (!renderedOnly) documents.push(
      {kind:'html',scope:'product',location:'captured rendered HTML',text:renderedHtml,origin:'rendered'},
      {kind:'extracted',scope:'extracted',location:'complete retained initial extraction',text:JSON.stringify(canonical(initialExtracted)),origin:'initial'}
    );
    documents.push(
      {kind:'metadata',scope:'metadata',location:'retained browser metadata',text:JSON.stringify(canonical(browserMetadata)),origin:'rendered'},
      {kind:'support',scope:'support',location:'retained supporting observations',text:JSON.stringify(canonical(supportMetadata)),origin:'shared'}
    );
  }
  // Plain excerpts supplement, rather than replace, the complete retained records.
  for (const block of preparedHtml ? [] : extracted.productHtml?.blocks || []) if (typeof block.text === 'string' && block.text) documents.push({ kind: 'text', scope: 'product', location: renderedOnly ? 'parsed rendered HTML product text' : block.location || 'product extraction', text: block.text });
  if (browser !== undefined && !preparedHtml) {
    for (const [field, property, fallback] of [['headings','text','rendered heading'],['selectedControls','value','rendered selected control'],['images','alt','rendered image alternative']]) {
      for (const item of extracted.productHtml?.[field] || []) if (typeof item[property] === 'string' && item[property]) documents.push({kind:'text',scope:'product',location:renderedOnly ? 'parsed rendered HTML product ' + field : item.location || fallback,text:item[property],origin:'rendered'});
    }
  }
  for (const name of ['shipping', 'returns']) {
    const policy = snapshot.policies?.[name];
    for (const block of policy?.extraction?.blocks || []) if (typeof block.text === 'string' && block.text) documents.push({ kind: 'text', scope: name, location: block.location || name + ' policy', url: policy.url, text: block.text });
  }
  for (const name of ['llms', 'agents']) {
    const guide = snapshot.guides?.[name];
    if (typeof guide?.text === 'string') documents.push({ kind: 'text', scope: name, location: 'retained ' + name + ' guide', url: guide.url, text: guide.text });
  }
  if (browser !== undefined) for (const document of documents) if (!document.origin) document.origin = document.scope === 'product' ? 'rendered' : 'shared';
  let total = 0;
  for (const document of documents) {
    if (typeof document.text !== 'string') throw new TypeError('Unserializable retained document');
    total += encoder.encode(document.text).length;
    if (total > MAX_SOURCE_BYTES) throw new RangeError('Assessment source limit exceeded');
  }
  const sources = [];
  for (const [documentIndex, document] of documents.entries()) {
    const bytes = encoder.encode(document.text);
    let start = 0;
    while (start < bytes.length) {
      let end = Math.min(bytes.length, start + SECTION_BYTES);
      // Never split a UTF-8 continuation sequence.
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end));
      sources.push({ id: 's' + (sources.length + 1), documentId: 'd' + (documentIndex + 1), kind: document.kind,
        url: document.url || snapshot.url, location: document.location + `; UTF-8 bytes ${start}-${end}`, scope: document.scope,
        start, end, text, ...(document.preparedHtml ? {preparedHtml:true} : {}), ...(document.origin ? {origin:document.origin,method:document.origin === 'rendered' ? 'rendered' : 'raw'} : {}) });
      start = end;
    }
  }
  const sourceDigest = await hash(encoder.encode(JSON.stringify(sources)));
  const initialComplete = !renderedOnly && !snapshot.htmlLimited && rawBytes.length > 0;
  const complete = renderedOnly ? !snapshot.htmlLimited && rawBytes.length > 0 && (preparedHtml || browser.coverage.complete === true) && browser.coverage.renderedLimited === false : initialComplete && (browser === undefined || (browser.coverage.complete === true && browser.coverage.initialLimited === false && browser.coverage.renderedLimited === false && renderedHtml.length > 0));
  const scopes = {product: complete};
  for (const name of ['shipping', 'returns']) scopes[name] = snapshot.policies?.[name]?.state === 'read' && snapshot.policies[name].extraction?.complete === true;
  for (const name of ['llms', 'agents']) scopes[name] = snapshot.guides?.[name + 'State'] === 'found' && typeof snapshot.guides?.[name]?.text === 'string';
  return { version: ASSESSMENT_SOURCE_VERSION, sources, sourceDigest,
    coverage: { complete, ...(preparedHtml ? {preparedHtml:true,absenceComplete:false,originalProvenance:'declared',parserComplete:extracted.productHtml?.complete === true,visibility:'unknown'} : {}), ...(browser !== undefined ? {initial:initialComplete && browser.coverage.initialLimited === false} : {}), scopes, reason: complete ? null : snapshot.htmlLimited || (browser && (!browser.coverage.complete || browser.coverage.initialLimited || browser.coverage.renderedLimited)) ? 'capture_limited' : 'empty_capture', bytes: total, sections: sources.length } };
}
