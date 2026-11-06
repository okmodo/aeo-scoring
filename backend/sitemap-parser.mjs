// A deliberately small XML 1.0 subset: reject constructs we cannot validate safely.
const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const MAX_CHARS = 32_768;
const MAX_ENTRIES = 500;
const MAX_DEPTH = 24;
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;
const VALID_CHAR = /^(?:[\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/;

function decode(value) {
  if (!VALID_CHAR.test(value)) throw new Error('invalid character');
  return value.replace(/&([^;\s<&]*);|[&<]/g, (match, entity) => {
    const predefined = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, entity)) return predefined[entity];
    if (entity && /^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) {
      const hex = entity[1] === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)) return String.fromCodePoint(code);
    }
    throw new Error('invalid entity');
  });
}

function splitName(name) {
  if (!NAME.test(name)) throw new Error('invalid name');
  const colon = name.indexOf(':');
  return colon < 0 ? ['', name] : [name.slice(0, colon), name.slice(colon + 1)];
}

export function parseSitemap(text) {
  try {
    if (typeof text !== 'string' || text.length > MAX_CHARS || !VALID_CHAR.test(text)) return null;
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    const stack = [];
    let root = null;
    let closed = false;
    const locations = [];
    let entries = 0;
    const whitespace = () => { const start = i; while (i < text.length && /[\t\n\r ]/.test(text[i])) i++; return i > start; };
    const name = () => { const start = i; while (i < text.length && /[A-Za-z0-9_.:-]/.test(text[i])) i++; const result = text.slice(start, i); splitName(result); return result; };
    if (text.startsWith('<?xml', i)) {
      const end = text.indexOf('?>', i + 5);
      if (end < 0 || !/^<\?xml[\t\n\r ]+version[\t\n\r ]*=[\t\n\r ]*(['"])1\.0\1(?:[\t\n\r ]+encoding[\t\n\r ]*=[\t\n\r ]*(['"])[Uu][Tt][Ff]-8\2)?(?:[\t\n\r ]+standalone[\t\n\r ]*=[\t\n\r ]*(['"])(?:yes|no)\3)?[\t\n\r ]*\?>$/.test(text.slice(i, end + 2))) return null;
      i = end + 2;
    }
    while (i < text.length) {
      if (text[i] !== '<') {
        const end = text.indexOf('<', i);
        const raw = text.slice(i, end < 0 ? text.length : end);
        if (raw.includes(']]>')) return null;
        const value = decode(raw);
        if (!stack.length && /[^\t\n\r ]/.test(raw)) return null;
        if (stack.length && (stack.at(-1).isRoot || stack.at(-1).entry) && /[^\t\n\r ]/.test(value)) return null;
        if (stack.length && stack.at(-1).isLoc) stack.at(-1).value += value;
        i = end < 0 ? text.length : end;
        continue;
      }
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4);
        if (end < 0) return null;
        const comment = text.slice(i + 4, end);
        if (comment.includes('--') || comment.endsWith('-')) return null;
        i = end + 3; continue;
      }
      if (text.startsWith('<![CDATA[', i)) {
        const end = text.indexOf(']]>', i + 9);
        if (end < 0 || !stack.length || ((stack.at(-1).isRoot || stack.at(-1).entry) && text.slice(i + 9, end).trim())) return null;
        if (stack.at(-1).isLoc) stack.at(-1).value += text.slice(i + 9, end);
        i = end + 3; continue;
      }
      if (text.startsWith('<!', i) || text.startsWith('<?', i)) return null;
      if (text.startsWith('</', i)) {
        i += 2; const closing = name(); whitespace();
        if (text[i++] !== '>' || !stack.length || stack.at(-1).name !== closing) return null;
        const node = stack.pop();
        if (node.isLoc) { if (!node.value.trim()) return null; locations.push(node.value.trim()); }
        if (node.entry && !node.hasLoc) return null;
        if (!stack.length) closed = true;
        continue;
      }
      if (closed || stack.length >= MAX_DEPTH || (stack.length && stack.at(-1).isLoc)) return null;
      i++; const tag = name();
      const attrs = [];
      let selfClosing = false;
      for (;;) {
        const spaced = whitespace();
        if (text.startsWith('/>', i)) { i += 2; selfClosing = true; break; }
        if (text[i] === '>') { i++; break; }
        if (!spaced) return null;
        const attr = name(); whitespace(); if (text[i++] !== '=') return null; whitespace();
        const quote = text[i++]; if (quote !== '"' && quote !== "'") return null;
        const end = text.indexOf(quote, i); if (end < 0) return null;
        const raw = text.slice(i, end); if (raw.includes('<')) return null;
        attrs.push([attr, decode(raw)]); i = end + 1;
      }
      const ns = Object.create(stack.length ? stack.at(-1).ns : null);
      if (!stack.length) ns.xml = XML_NS;
      const seenRaw = new Set();
      for (const [attr, value] of attrs) {
        if (seenRaw.has(attr)) return null; seenRaw.add(attr);
        if (attr === 'xmlns' || attr.startsWith('xmlns:')) {
          const prefix = attr === 'xmlns' ? '' : attr.slice(6);
          if (prefix === 'xmlns' || value === XMLNS_NS || (prefix === 'xml') !== (value === XML_NS) || (prefix && !value)) return null;
          ns[prefix] = value;
        }
      }
      const expanded = (qname, attribute = false) => {
        const [prefix, local] = splitName(qname);
        if (prefix === 'xmlns' || (prefix && !ns[prefix])) throw new Error('unbound prefix');
        return [(prefix || !attribute) ? (ns[prefix] || '') : '', local];
      };
      const seenExpanded = new Set();
      for (const [attr] of attrs) {
        if (attr === 'xmlns' || attr.startsWith('xmlns:')) continue;
        const key = JSON.stringify(expanded(attr, true)); if (seenExpanded.has(key)) return null; seenExpanded.add(key);
      }
      const [uri, local] = expanded(tag);
      if (!stack.length) {
        if (root || uri !== SITEMAP_NS || !['urlset', 'sitemapindex'].includes(local)) return null;
        root = local;
      }
      const parent = stack.at(-1);
      const entry = stack.length === 1 && uri === SITEMAP_NS && local === (root === 'urlset' ? 'url' : 'sitemap');
      if (stack.length === 1 && !entry) return null;
      if (entry && ++entries > MAX_ENTRIES) return null;
      const isLoc = stack.length === 2 && parent.entry && uri === SITEMAP_NS && local === 'loc';
      if (isLoc && parent.hasLoc) return null;
      if (isLoc) parent.hasLoc = true;
      const node = { name: tag, ns, entry, isLoc, isRoot: !stack.length, value: '', hasLoc: false };
      if (selfClosing) {
        if (isLoc || entry) return null;
        if (!stack.length) closed = true;
      } else stack.push(node);
    }
    return root && closed && !stack.length ? { kind: root, locations } : null;
  } catch { return null; }
}
