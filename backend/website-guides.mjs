// Only award positive evidence when all three independent signals are present.
// Guide text is untrusted; returned descriptions deliberately contain no guide text.
function assessGuide(guide, finalUrl, paths) {
  if (!guide || typeof guide.url !== 'string' || typeof guide.text !== 'string' || guide.text.length > 8192) return null;
  let product;
  let source;
  try {
    product = new URL(finalUrl);
    source = new URL(guide.url);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(product.protocol) || source.origin !== product.origin || source.username || source.password || source.search || source.hash || !paths.includes(source.pathname)) return null;
  const labels = product.hostname.toLowerCase().split('.');
  if (labels[0] === 'www') labels.shift();
  const site = labels[0];
  if (!site || site.length < 3 || !/^[a-z0-9-]+$/.test(site)) return null;

  // Exclude HTML and comments rather than interpreting their hidden contents.
  const text = guide.text;
  if (/<!--|-->|<[^<>]*>/.test(text)) return null;
  const lines = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    if (line.includes('`') || line.includes(']:')) return null;
    if (!/^(?: {4}|\t)/.test(line)) lines.push(line);
  }
  if (fence) return null;
  const headings = lines.filter(line => /^ {0,3}#[ \t]+/.test(line));
  const heading = headings.length === 1 && headings[0] === lines.find(line => line.trim()) &&
    headings[0].trim().slice(1).trim().replace(/\s+#+$/, '').toLowerCase().replace(/[ -]+/g, '-') === site;
  // Require a natural-language statement about the store's offering, not an instruction.
  const purpose = lines.some(line => {
    const plain = line.trim().replace(/^>\s*/, '');
    return plain.length >= 35 && plain.length <= 300 &&
      /^(?:we|our (?:store|shop|site)|this (?:store|shop|site)|the (?:store|shop|site))\s+(?:sell|sells|offer|offers|provide|provides|specialize|specializes)\b/i.test(plain) &&
      /\b(?:products?|goods|equipment|clothing|apparel|accessories|supplies|furniture|books|food|beverages|items|merchandise)\b/i.test(plain) &&
      !/[<>`\[\]]|\b(?:ignore|instructions?|system|prompt|assistant|agent|repository|install|command)\b/i.test(plain);
  });
  const productLink = lines.some(line => {
    const link = line.match(/^ {0,3}(?:[-*+] )?\[[\p{L}\p{N}][\p{L}\p{N} .,&-]{0,119}\]\(([^\s()]+)\)\s*$/u);
    return link?.[1] === finalUrl;
  });
  return heading && purpose && productLink ? {
    url: guide.url,
    location: 'Site heading, purpose summary, and product link',
    excerpt: 'The guide identifies the site, summarizes its storefront purpose, and links to the audited product.',
    fraction: 1,
  } : null;
}

export function assessWebsiteGuides({ llms = null, agents = null } = {}, finalUrl) {
  const result = {};
  const identity = assessGuide(llms, finalUrl, ['/llms.txt']);
  const context = assessGuide(agents, finalUrl, ['/AGENTS.md', '/agents.md']);
  if (identity) result['S7.identity'] = identity;
  if (context) result['S8.context'] = context;
  return result;
}
