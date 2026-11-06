// The supplied egress is the network security boundary. This module never falls
// back to global fetch and validates every URL before handing it to that boundary.
import { robotsPathMatch, ROBOTS_MATCH_MAX_WORK } from './robots-path.mjs';
import crawlers from '../config/crawlers.v1.json' with { type: 'json' };

const scoredBots = Object.values(crawlers.scoring).flatMap(group => group.botIds)
  .map(id => crawlers.bots.find(bot => bot.id === id));

const DEFAULTS = { maxBytes: 512 * 1024, maxRobotsBytes: 64 * 1024, timeoutMs: 8000, maxRedirects: 3 };

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

const unsafeUrlCharacters = /[\\\x00-\x20\x7f]/;

function checkedUrl(input) {
  let url;
  if (typeof input !== 'string' || input.length > 2048 || unsafeUrlCharacters.test(input)) throw failure('invalid_url', 'URL must be a string of at most 2048 characters without whitespace, control characters, or backslashes');
  try { url = new URL(input); } catch { throw failure('invalid_url', 'Invalid URL'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      !host.includes('.') || host.length > 253 ||
      /(?:^|\.)(?:localhost|local|internal|invalid|test|onion|home|lan|alt)$/.test(host) ||
      /(?:^|\.)home\.arpa$/.test(host) || /^\[.*\]$/.test(host) || /^[\d.]+$/.test(host) ||
      !host.split('.').every(label => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) {
    throw failure('invalid_url', 'URL must use a public hostname without credentials');
  }
  url.hash = '';
  return url;
}

export function normalizeTarget(input) { return checkedUrl(input).toString(); }

function discard(response) { response?.body?.cancel().catch(() => {}); }

async function withTimeout(promise, signal) {
  if (signal.aborted) throw failure('timeout', 'Retrieval timed out');
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(failure('timeout', 'Retrieval timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function boundedResponse(response, limit, signal) {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > limit) { discard(response); throw failure('too_large', 'Response exceeds byte limit'); }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await withTimeout(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw failure('too_large', 'Response exceeds byte limit');
      chunks.push(part.value);
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

// Unknown directives and ambiguous target encodings still fail closed.
function parseRobots(text) {
  let agents = [], rules = [], inRules = false, groups = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) throw failure('robots_unknown', 'Malformed robots policy');
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (inRules) { groups.push({ agents, rules }); agents = []; rules = []; inRules = false; }
      if (!value || !/^(?:\*|[a-z0-9_-]+)$/i.test(value)) throw failure('robots_unknown', 'Malformed robots user agent');
      agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      if (!agents.length || (value && !value.startsWith('/'))) throw failure('robots_unknown', 'Malformed robots rule');
      inRules = true;
      if (value) rules.push({ key, value });
    } else if (!['sitemap', 'crawl-delay', 'host'].includes(key) || !value) {
      throw failure('robots_unknown', 'Unrecognized robots policy');
    }
  }
  if (agents.length) groups.push({ agents, rules });
  return groups;
}

function robotsAllowed(groups, url, userAgent = 'AEOAuditBot', budget = { work: 0 }) {
  const specific = groups.filter(group => group.agents.some(agent => agent !== '*' && agent === userAgent.toLowerCase()));
  const applicable = specific.length ? specific : groups.filter(group => group.agents.includes('*'));
  function decodeUnreserved(value, isTarget) {
    if (isTarget && /%(?![0-9a-f]{2})/i.test(value)) throw failure('robots_unknown', 'Ambiguous URL encoding');
    return value.replace(/%([0-9a-f]{2})/gi, (encoded, hex) => {
      const character = String.fromCharCode(parseInt(hex, 16));
      if (/^[a-z0-9._~-]$/i.test(character)) return character;
      if (isTarget) throw failure('robots_unknown', 'Escaped reserved or non-ASCII character');
      return encoded.toUpperCase();
    });
  }
  const rawPath = url.pathname + url.search;
  const path = decodeUnreserved(rawPath, true);
  let match = null;
  for (const group of applicable) for (const rule of group.rules) {
    const value = decodeUnreserved(rule.value, false);
    // No accepted target retains a percent escape. A rule with a literal percent
    // cannot match that target, including Shopify's partial-escape patterns.
    if (value.includes('%')) {
      if (rawPath.includes('%')) throw failure('robots_unknown', 'Ambiguous escaped rule and target');
      continue;
    }
    budget.work += (value.length + 1) * (path.length + 1);
    if (budget.work > ROBOTS_MATCH_MAX_WORK) throw failure('robots_unknown', 'Robots path matching budget exceeded');
    const { matches, specificity } = robotsPathMatch(path, value);
    if (matches && (!match || specificity > match.specificity ||
        (specificity === match.specificity && rule.key === 'allow'))) match = { key: rule.key, specificity };
  }
  return match?.key !== 'disallow';
}

export async function retrieve(input, options = {}) {
  const { egress, maxBytes, maxRobotsBytes, timeoutMs, maxRedirects } = { ...DEFAULTS, ...options };
  if (!egress || typeof egress.fetch !== 'function') throw failure('egress_required', 'Trusted public-network egress required');
  for (const n of [maxBytes, maxRobotsBytes, timeoutMs]) if (!Number.isSafeInteger(n) || n < 1) throw failure('invalid_limits', 'Limits must be positive integers');
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) throw failure('invalid_limits', 'Invalid redirect limit');
  let url = checkedUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const budget = { work: 0 };
  const fetchBounded = async target => {
    try {
      const pending = Promise.resolve(egress.fetch(target.toString(), { method: 'GET', redirect: 'manual', headers: { 'user-agent': 'AEOAuditBot/1.0', accept: 'text/html,text/plain;q=0.9' }, signal: controller.signal }));
      pending.then(response => { if (controller.signal.aborted) discard(response); }, () => {});
      return await withTimeout(pending, controller.signal);
    } catch (error) { if (controller.signal.aborted) throw failure('timeout', 'Retrieval timed out'); throw failure('fetch_failed', 'Egress request failed'); }
  };
  try {
    for (let redirects = 0; ; redirects++) {
      const robotsUrl = new URL('/robots.txt', url);
      const robotsResponse = await fetchBounded(robotsUrl);
      let policy = null;
      const missingPolicy = robotsResponse.status === 404 || robotsResponse.status === 410;
      if (missingPolicy) discard(robotsResponse);
      else {
        if (robotsResponse.status !== 200 || !/^text\/plain(?:\s*;|\s*$)/i.test(robotsResponse.headers.get('content-type') || '')) { discard(robotsResponse); throw failure('robots_unknown', 'Robots policy unavailable'); }
        try { policy = await boundedResponse(robotsResponse, maxRobotsBytes, controller.signal); }
        catch (error) { if (error.code === 'timeout') throw error; throw failure('robots_unknown', 'Robots policy unavailable'); }
        policy = parseRobots(policy);
        if (!robotsAllowed(policy, url, 'AEOAuditBot', budget)) throw failure('robots_denied', 'Robots policy does not permit retrieval');
      }
      const response = await fetchBounded(url);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        discard(response);
        if (redirects >= maxRedirects) throw failure('too_many_redirects', 'Redirect limit exceeded');
        const location = response.headers.get('location');
        if (!location || unsafeUrlCharacters.test(location)) throw failure('invalid_redirect', 'Redirect has no valid location');
        try { url = checkedUrl(new URL(location, url).toString()); }
        catch { throw failure('invalid_redirect', 'Redirect destination is invalid'); }
        continue;
      }
      if (!response.ok) { discard(response); throw failure('http_error', `Page returned HTTP ${response.status}`); }
      const contentType = response.headers.get('content-type') || '';
      if (!/^text\/html(?:\s*;|\s*$)/i.test(contentType)) { discard(response); throw failure('unsupported_content', 'Page is not HTML'); }
      const body = await boundedResponse(response, maxBytes, controller.signal);
      const observations = scoredBots.map(bot => {
        let status = 'not_measured';
        if (missingPolicy && bot.robots.missingFilePolicy === 'allow') status = 'allowed';
        else if (policy !== null && bot.robots.respectsRules === true) {
          try { status = robotsAllowed(policy, url, bot.userAgentToken, budget) ? 'allowed' : 'disallowed'; }
          catch (error) { if (error.code !== 'robots_unknown' && !(error instanceof RangeError)) throw error; }
        }
        return { botId: bot.id, status };
      });
      return { url: url.toString(), status: response.status, contentType, body, robots: 'allowed', crawlerPolicy: { version: crawlers.version, url: robotsUrl.toString(), httpStatus: robotsResponse.status, observations } };
    }
  } finally { clearTimeout(timer); }
}

export async function extract(snapshot, options = {}) {
  const Rewriter = options.HTMLRewriter || globalThis.HTMLRewriter;
  if (!Rewriter) throw failure('extractor_unavailable', 'HTMLRewriter runtime required');
  const result = { title: '', description: '', headings: [], canonical: '', jsonLd: [], coverage: { html: true, bodyText: false, usable: false, visibility: 'unknown', jsonLdTruncated: false } };
  const maxItems = 100, maxText = 8192;
  const rewriter = new Rewriter();
  // Keep identity evidence independent from the legacy, per-text-node fields.
  // Element end callbacks are required so nested text nodes form one complete value.
  result.labelEvidence = { title: null, mainH1: null };
  const identity = { title: { count: 0, active: null, value: null }, mainH1: { count: 0, active: null, value: null } };
  let mains = 0, unsafeMain = false;
  const markUnsafeMain = { element() { unsafeMain = true; } };
  const explicitlyHidden = element => ['hidden', 'inert', 'aria-hidden', 'style']
    .some(attribute => element.getAttribute(attribute) != null);
  function identityHandler(state) {
    return {
      element(element) {
        state.count = Math.min(2, state.count + 1);
        if (state.count > 1) { if (state.active) state.active.invalid = true; state.active = null; return; }
        const current = { value: '', invalid: explicitlyHidden(element), ended: false };
        if (state.active) { state.active.invalid = true; current.invalid = true; }
        state.active = current;
        if (typeof element.onEndTag !== 'function') { current.invalid = true; return; }
        element.onEndTag(() => {
          current.ended = true;
          if (state.active === current) state.active = null;
          state.value = current;
        });
      },
      text(chunk) {
        const current = state.active;
        if (!current) return;
        if (current.value.length + chunk.text.length > maxText) current.invalid = true;
        else current.value += chunk.text;
      },
    };
  }
  rewriter.on('head title', identityHandler(identity.title));
  rewriter.on('main', { element(element) { mains = Math.min(2, mains + 1); if (explicitlyHidden(element)) unsafeMain = true; } });
  rewriter.on('main h1', identityHandler(identity.mainH1));
  for (const selector of ['style', 'script:not([type="application/ld+json"])']) rewriter.on(selector, markUnsafeMain);
  rewriter.on('main h1 *', { element(element) { if ((explicitlyHidden(element) || /^(?:script|style|template|noscript)$/i.test(element.tagName || '')) && identity.mainH1.active) identity.mainH1.active.invalid = true; } });
  // A styled ancestor is treated conservatively because selector callbacks expose
  // the matched descendant, not the ancestor's computed style.
  for (const ancestor of ['[hidden]', '[inert]', '[aria-hidden]', '[style]', 'template', 'noscript', 'details', 'dialog']) {
    for (const selector of [`${ancestor} main`, `main ${ancestor} h1`]) {
      rewriter.on(selector, markUnsafeMain);
    }
  }
  function textHandler(callback) {
    let value = '';
    return { text(chunk) { value = (value + chunk.text).slice(0, maxText); if (chunk.lastInTextNode) { callback(value.trim()); value = ''; } } };
  }
  for (const selector of ['body p', 'body h1', 'body h2', 'body h3', 'body h4', 'body h5', 'body h6', 'body li']) rewriter.on(selector, textHandler(value => { if (value) result.coverage.usable = true; }));
  rewriter.on('title', textHandler(value => { if (!result.title && value) result.title = value; }));
  rewriter.on('meta[name]', { element(element) { if (element.getAttribute('name')?.toLowerCase() === 'description' && !result.description) result.description = (element.getAttribute('content') || '').slice(0, maxText); } });
  rewriter.on('link[rel]', { element(element) {
    const rel = (element.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    if (rel.includes('stylesheet')) unsafeMain = true;
    if (rel.includes('canonical') && !result.canonical) result.canonical = (element.getAttribute('href') || '').slice(0, maxText);
  } });
  for (const level of [1, 2, 3, 4, 5, 6]) rewriter.on(`h${level}`, textHandler(value => { if (value && result.headings.length < maxItems) result.headings.push({ level, text: value }); }));
  let jsonLdValue = '', jsonLdOverlong = false;
  rewriter.on('script[type="application/ld+json"]', { text(chunk) {
    if (jsonLdValue.length + chunk.text.length > maxText) jsonLdOverlong = true;
    if (!jsonLdOverlong) jsonLdValue += chunk.text;
    if (chunk.lastInTextNode) {
      if (jsonLdOverlong || (jsonLdValue.trim() && result.jsonLd.length >= maxItems)) result.coverage.jsonLdTruncated = true;
      else if (jsonLdValue.trim()) result.jsonLd.push(jsonLdValue.trim());
      jsonLdValue = ''; jsonLdOverlong = false;
    }
  } });
  const transformed = rewriter.transform(new Response(snapshot.body, { headers: { 'content-type': 'text/html' } }));
  if (transformed.body) { const reader = transformed.body.getReader(); while (!(await reader.read()).done) { /* drain without buffering output */ } }
  for (const [key, state] of Object.entries(identity)) {
    const value = state.value;
    if (state.count === 1 && value && value.ended && !value.invalid && value.value.trim() &&
        (key !== 'mainH1' || (mains === 1 && !unsafeMain))) result.labelEvidence[key] = value.value.trim();
  }
  return result;
}
