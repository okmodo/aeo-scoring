import { MAX_RENDERED_HTML_BYTES } from './snapshot-store.mjs';

export const MAX_CLEANED_HTML_BYTES = 4 * 1024 * 1024 - 64 * 1024;
const encoder = new TextEncoder();
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const sourceKey = new RegExp(`^retained/${uuid}/${uuid}/html$`, 'i');
const presentation = new Set(['class', 'style', 'width', 'height', 'align', 'valign', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'color', 'face']);
const eventAttributes = new Set(('onabort onafterprint onanimationcancel onanimationend onanimationiteration onanimationstart onauxclick onbeforeinput onbeforeprint onbeforeunload onblur oncancel oncanplay oncanplaythrough onchange onclick onclose oncontextmenu oncopy oncuechange oncut ondblclick ondrag ondragend ondragenter ondragleave ondragover ondragstart ondrop ondurationchange onemptied onended onerror onfocus onfocusin onfocusout onformdata oninput oninvalid onkeydown onkeypress onkeyup onload onloadeddata onloadedmetadata onloadstart onmessage onmousedown onmouseenter onmouseleave onmousemove onmouseout onmouseover onmouseup onoffline ononline onpagehide onpageshow onpaste onpause onplay onplaying onpointercancel onpointerdown onpointerenter onpointerleave onpointermove onpointerout onpointerover onpointerup onprogress onratechange onreset onresize onscroll onsecuritypolicyviolation onseeked onseeking onselect onslotchange onstalled onsubmit onsuspend ontimeupdate ontoggle ontouchcancel ontouchend ontouchmove ontouchstart ontransitioncancel ontransitionend ontransitionrun ontransitionstart onunload onvolumechange onwaiting onwheel').split(' '));
const svgGeometry = new Set(['d', 'points', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'viewbox', 'transform', 'pathlength', 'preserveaspectratio']);
const svgPaint = new Set(['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'fill-rule', 'clip-rule', 'opacity', 'fill-opacity', 'stroke-opacity', 'vector-effect']);
const fail = code => Object.assign(new Error('HTML preprocessing failed'), { code });
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

async function boundedBody(response) {
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CLEANED_HTML_BYTES) throw fail('preprocessing_oversize');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

// This is a structural reduction, not a sanitizer or a visibility determination.
export async function preprocessHtml({ rawHtml, sourceObjectKey, expiresAt }, { HTMLRewriter = globalThis.HTMLRewriter, now = Date.now } = {}) {
  const preparedAt = now();
  if (!sourceKey.test(sourceObjectKey || '') || !Number.isSafeInteger(preparedAt) || preparedAt < 0 || !Number.isSafeInteger(expiresAt) || expiresAt <= preparedAt || typeof HTMLRewriter !== 'function') throw fail('preprocessing_invalid');
  let source;
  if (typeof rawHtml === 'string') {
    // Reject unpaired surrogates instead of silently replacing them during encoding.
    source = encoder.encode(rawHtml);
    if (new TextDecoder('utf-8', { fatal: true }).decode(source) !== rawHtml) throw fail('preprocessing_invalid_utf8');
  } else if (rawHtml instanceof Uint8Array) source = rawHtml;
  else throw fail('preprocessing_invalid');
  if (source.byteLength > MAX_RENDERED_HTML_BYTES) throw fail('preprocessing_oversize');
  try { new TextDecoder('utf-8', { fatal: true }).decode(source); } catch { throw fail('preprocessing_invalid_utf8'); }
  const counts = { scriptsRemoved: 0, stylesRemoved: 0, stylesheetLinksRemoved: 0, commentsRemoved: 0, attributesRemoved: 0 };
  const rewriter = new HTMLRewriter().on('*', { element(element) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'script') {
      const type = (element.getAttribute('type') || '').split(';', 1)[0].trim().toLowerCase();
      if (!/^(?:application|text)\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(type)) { counts.scriptsRemoved++; element.remove(); return; }
    }
    if (tag === 'style') { counts.stylesRemoved++; element.remove(); return; }
    if (tag === 'link' && (element.getAttribute('rel') || '').toLowerCase().split(/\s+/).includes('stylesheet')) { counts.stylesheetLinksRemoved++; element.remove(); return; }
    const svg = element.namespaceURI === 'http://www.w3.org/2000/svg';
    for (const [name, value] of [...element.attributes]) {
      const lower = name.toLowerCase();
      // Keep explicit source markers and references; these do not establish computed visibility.
      const contextClass = lower === 'class' && /(?:recommend|related|reviews?|upsell|store[-_]?pickup)/i.test(value);
      const meaningfulStyle = lower === 'style' && /(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden|url\s*\()/i.test(value);
      if (eventAttributes.has(lower) || (presentation.has(lower) && !contextClass && !meaningfulStyle) || (svg && (svgGeometry.has(lower) || (svgPaint.has(lower) && !/url\s*\(/i.test(value))))) {
        element.removeAttribute(name); counts.attributesRemoved++;
      }
    }
  }}).onDocument({ comments(comment) { counts.commentsRemoved++; comment.remove(); } });
  const html = await boundedBody(rewriter.transform(new Response(source, { headers: { 'content-type': 'text/html; charset=utf-8' } })));
  const [sourceSha256, outputSha256] = await Promise.all([hash(source), hash(html)]);
  return { html, preprocessing: { version: 'simplified-html-v1', representation: 'cleaned_rendered_html', originalCapturePreserved: true, sourceObjectKey, sourceSha256, sourceBytes: source.byteLength, outputSha256, outputBytes: html.byteLength, preparedAt, expiresAt, operations: ['remove_non_json_scripts', 'remove_styles', 'remove_comments', 'remove_presentation_attributes', 'remove_svg_geometry_and_plain_paint'], ...counts } };
}
