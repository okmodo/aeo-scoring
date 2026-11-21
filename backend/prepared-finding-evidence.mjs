// Resolve only within the cited prepared section. No source discovery or semantic repair.
const named = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'};
const entity = /^&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/i;
function normalized(input) {
  let text = '', spans = [];
  for (let i = 0; i < input.length;) {
    const match = input.slice(i).match(entity);
    let value = input[i], end = i + 1;
    if (match) {
      const token = match[0], name = token.slice(1,-1).toLowerCase();
      let code = name.startsWith('#x') ? parseInt(name.slice(2),16) : name.startsWith('#') ? Number(name.slice(1)) : null;
      if (code !== null && Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) value = String.fromCodePoint(code);
      else if (Object.hasOwn(named,name)) value = named[name];
      else { text += value; spans.push([i,end]); i = end; continue; }
      end = i + token.length;
    }
    if (/\s/u.test(value)) {
      if (text.endsWith(' ')) spans[spans.length-1][1] = end;
      else { text += ' '; spans.push([i,end]); }
    } else {
      text += value;
      for (let j = 0; j < value.length; j++) spans.push([i,end]);
    }
    i = end;
  }
  return {text,spans};
}
function normalizedQuote(text, quote) {
  const source = normalized(text), needle = normalized(quote).text;
  if (!needle.trim()) return null;
  const at = source.text.indexOf(needle);
  if (at < 0 || source.text.indexOf(needle,at+1) >= 0) return null;
  return text.slice(source.spans[at][0],source.spans[at+needle.length-1][1]);
}
function structured(ref, source, sources) {
  if (!['structured_product','extracted','metadata','support'].includes(source.kind) || !Array.isArray(ref.fieldPath) || !ref.fieldPath.length || ref.fieldPath.length > 32 || !Object.hasOwn(ref,'value')) return null;
  if (source.start !== 0 || sources.filter(s=>s.documentId === source.documentId).length !== 1 || source.end !== new TextEncoder().encode(source.text).length) return null;
  let value;
  try { value = JSON.parse(source.text); } catch { return null; }
  for (const key of ref.fieldPath) {
    if (!((typeof key === 'string' && key.length > 0 && key.length <= 200) || (Number.isSafeInteger(key) && key >= 0)) || value === null || typeof value !== 'object' || !Object.hasOwn(value,key)) return null;
    value = value[key];
  }
  if (value === null || !['string','number','boolean'].includes(typeof value) || typeof value !== typeof ref.value || value !== ref.value || (typeof value === 'string' && !value.length)) return null;
  const quote = JSON.stringify(value);
  return quote.length <= 1000 && source.text.includes(quote) ? quote : null;
}
export function resolvePreparedReferences(references, sources, options = {}) {
  if (!Array.isArray(references) || !Array.isArray(sources)) throw new TypeError('Invalid prepared references');
  if (references.length > 16) return {evidence:[],rejections:[{reason:'reference_limit'}]};
  const allowed = options.allowedSourceIds === undefined ? null : new Set(options.allowedSourceIds);
  const evidence = [], rejections = [];
  for (const [referenceIndex,ref] of references.entries()) {
    const sourceId = ref?.sourceId;
    const reject = reason => rejections.push({referenceIndex,sourceId,reason});
    if (typeof sourceId !== 'string') { reject('invalid_reference'); continue; }
    const matches = sources.filter(s=>s.id === sourceId);
    if (matches.length !== 1) { reject('unknown_source'); continue; }
    if (allowed && !allowed.has(sourceId)) { reject('source_not_in_batch'); continue; }
    const source = matches[0];
    if (typeof source.text !== 'string') { reject('invalid_source'); continue; }
    let quote, match;
    if (Object.hasOwn(ref,'fieldPath')) {
      quote = structured(ref,source,sources); match = 'structured_field';
      if (!quote) { reject('invalid_structured_field'); continue; }
    } else {
      if (typeof ref.quote !== 'string' || !ref.quote.trim() || ref.quote.length > 1000) { reject('invalid_quote'); continue; }
      quote = source.text.includes(ref.quote) ? ref.quote : normalizedQuote(source.text,ref.quote);
      match = quote === ref.quote ? 'exact' : 'normalized';
      if (!quote) { reject('quote_not_found_or_ambiguous'); continue; }
    }
    evidence.push({referenceIndex,sourceId,quote,url:source.url,location:source.location,excerpt:quote,scope:source.scope,...(source.method ? {method:source.method} : {}),match,...(match === 'structured_field' ? {fieldPath:ref.fieldPath,value:ref.value} : {})});
  }
  return {evidence,rejections};
}
