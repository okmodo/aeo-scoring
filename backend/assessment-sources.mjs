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
  if (rawBytes.length > 1024 * 1024) throw new RangeError('Retained HTML exceeds limit');
  // Reject undecodable bytes instead of replacing them and claiming full inspection.
  const html = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  const { rawHtml, extracted: ignoredExtracted, body, ...metadata } = snapshot;
  const documents = [
    { kind: 'html', scope: 'product', location: 'captured initial HTML', text: html },
    { kind: 'metadata', scope: 'metadata', location: 'retained retrieval metadata and supporting observations', text: JSON.stringify(canonical(metadata)) },
    { kind: 'extracted', scope: 'extracted', location: 'complete retained extraction', text: JSON.stringify(canonical(extracted)) },
  ];
  // Plain excerpts supplement, rather than replace, the complete retained records.
  for (const block of extracted.productHtml?.blocks || []) if (typeof block.text === 'string' && block.text) documents.push({ kind: 'text', scope: 'product', location: block.location || 'product extraction', text: block.text });
  for (const name of ['shipping', 'returns']) {
    const policy = snapshot.policies?.[name];
    for (const block of policy?.extraction?.blocks || []) if (typeof block.text === 'string' && block.text) documents.push({ kind: 'text', scope: name, location: block.location || name + ' policy', url: policy.url, text: block.text });
  }
  for (const name of ['llms', 'agents']) {
    const guide = snapshot.guides?.[name];
    if (typeof guide?.text === 'string') documents.push({ kind: 'text', scope: name, location: 'retained ' + name + ' guide', url: guide.url, text: guide.text });
  }
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
        start, end, text });
      start = end;
    }
  }
  const sourceDigest = await hash(encoder.encode(JSON.stringify(sources)));
  const complete = !snapshot.htmlLimited && rawBytes.length > 0;
  const scopes = {product: complete};
  for (const name of ['shipping', 'returns']) scopes[name] = snapshot.policies?.[name]?.state === 'read' && snapshot.policies[name].extraction?.complete === true;
  for (const name of ['llms', 'agents']) scopes[name] = snapshot.guides?.[name + 'State'] === 'found' && typeof snapshot.guides?.[name]?.text === 'string';
  return { version: ASSESSMENT_SOURCE_VERSION, sources, sourceDigest,
    coverage: { complete, scopes, reason: complete ? null : snapshot.htmlLimited ? 'capture_limited' : 'empty_capture', bytes: total, sections: sources.length } };
}
