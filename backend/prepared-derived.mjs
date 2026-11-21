import {extract} from './retrieval.mjs';

// Parse only at publication, not during each model checkpoint continuation.
export const MAX_DERIVED_HTML_BYTES = 4 * 1024 * 1024 - 64 * 1024;
const derivedInputs = new WeakMap(), encoder = new TextEncoder();
const serializeSnapshot = snapshot => JSON.stringify(snapshot, (key, value) => key === 'rawHtml' ? undefined : value);
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
export function isPreparedObservations(value, snapshot) {
  const bound = derivedInputs.get(value);
  if (!bound || bound.snapshot !== snapshot) return false;
  try { return bound.snapshotJSON === serializeSnapshot(snapshot) && bound.resultJSON === JSON.stringify(value); } catch { return false; }
}
export async function derivePreparedObservations(input, {HTMLRewriter = globalThis.HTMLRewriter} = {}) {
  const snapshot=input?.snapshot, html=snapshot?.browser?.renderedHtml, prepared=input?.prepared, p=prepared?.preprocessing, source=input?.source;
  if (typeof html !== 'string' || !HTMLRewriter || prepared?.version !== '1' || prepared.html !== html ||
      p?.version !== 'simplified-html-v1' || p.representation !== 'cleaned_rendered_html' || p.originalCapturePreserved !== true ||
      JSON.stringify(snapshot.preprocessing) !== JSON.stringify(p) || !/^[a-f0-9]{64}$/.test(source?.preparedHash || '') ||
      source.sha256 !== source.preparedHash || !source.objectKey?.endsWith('/prepared')) return null;
  const bytes=encoder.encode(html), preparedBytes=encoder.encode(JSON.stringify(prepared));
  if (bytes.length > MAX_DERIVED_HTML_BYTES || p.outputBytes !== bytes.length || source.bytes !== preparedBytes.length ||
      await digest(bytes) !== p.outputSha256 || await digest(preparedBytes) !== source.preparedHash) return null;
  const snapshotJSON=serializeSnapshot(snapshot);
  const result = await extract({body:html, htmlLimited:null}, {HTMLRewriter});
  if (snapshotJSON !== serializeSnapshot(snapshot)) return null;
  derivedInputs.set(result, {snapshot,snapshotJSON,resultJSON:JSON.stringify(result)});
  return result;
}
