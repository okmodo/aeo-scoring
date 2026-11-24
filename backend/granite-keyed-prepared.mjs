import rubric from '../config/rubric.v2.json' with { type: 'json' };
import categories from '../config/categories.v1.2.json' with { type: 'json' };
import { prepareBinaryBenchmark, runBinaryBenchmark } from '../scripts/granite-binary-harness.mjs';
import { createGraniteResponseStore, retryModelWrite } from '../scripts/granite-response-store.mjs';
import { prepareAssessmentSources } from './assessment-sources.mjs';

const encoder = new TextEncoder();
const checkpoint = 'granite-keyed';
const attemptPrefix = auditId => 'granite-queue-' + auditId;
const attempt = ({ fixture, inputDigest }) => attemptPrefix(fixture.capture.auditId) + '-' + inputDigest;
const fail = code => Object.assign(new Error(code), { code });
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
  byte => byte.toString(16).padStart(2, '0')).join('');
const rubricChecks = new Map(rubric.criteria.flatMap(criterion => criterion.subchecks.map(check => [check.id, check])));
const policies = {
  'S4.title': ['heading', 'title'],
  'S4.organization': ['description_heading', 'details_heading'],
  'C1.identity': ['heading', 'brand'],
  'C1.explanation': ['description'],
  // Reserved for evidence that establishes the complete current configuration and inclusions.
  'C1.configuration': ['selected_configuration'],
  'C2.essential': ['composition', 'fit_dimension'],
  'C2.supporting': ['construction', 'care'],
  'C3.price': ['price', 'currency'],
  'C3.availability': ['selected_stock'],
  'C4.intended-use': ['description'],
  'C4.compatibility': ['compatibility'],
  'C4.limitations': ['care'],
  'C4.selection': ['fit', 'size_reference'],
};
const questionRules = {
  'C1.identity': 'The primary product name and brand are explicit in the eligible evidence.',
  'C2.essential': 'The apparel composition, fit, and dimensions are explicit, with material proportions and measurement units.',
  'C2.supporting': 'Construction details and specific, applicable care information are disclosed where relevant to the product.',
  'C4.intended-use': 'The product description names a use or occasion and a feature that supports that use.',
  'C4.compatibility': 'The evidence states an applicable compatibility requirement or pairing.',
  'C4.limitations': 'The evidence states an applicable restriction, precaution or care limitation.',
  'C4.selection': 'The evidence gives product-specific advice for selecting the fit, size or configuration.',
};

function primaryProductData(scripts, name, url) {
  const matches = [];
  for (const script of scripts ?? []) {
    let parsed;
    try { parsed = JSON.parse(script); } catch { continue; }
    const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [parsed];
    for (const record of records) {
      if (!['Product', 'ProductGroup'].includes(record?.['@type']) || record.name !== name) continue;
      try {
        const target = new URL(record.url ?? record.mainEntityOfPage);
        target.hash = '';
        if (target.href === url) matches.push(record);
      } catch { /* An unassociated structured record is ineligible. */ }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

// Resolve parser-verified selected controls back to their original markup. The
// raw tag is the evidence: a value alone does not show that it was selected.
function selectedOptionQuote(tags, item) {
  if (item.kind !== 'selected-option' || !item.name || !item.text || !item.value) return null;
  const safe = value => typeof value === 'string' && /^[^&<>"'\s]+$/.test(value);
  if (![item.name, item.value].every(safe) || typeof item.text !== 'string' || /[&<>"']/.test(item.text)) return null;
  const parse = tag => {
    const attrs = new Map();
    const pattern = /\s+([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
    let pos = '<input'.length;
    while (pos < tag.length) {
      if (/^\s*\/?>$/.test(tag.slice(pos))) return attrs;
      pattern.lastIndex = pos;
      const match = pattern.exec(tag);
      if (!match) return null;
      const name = match[1].toLowerCase();
      if (attrs.has(name)) return null;
      attrs.set(name, match[2] ?? match[3] ?? match[4] ?? '');
      pos = pattern.lastIndex;
    }
    return null;
  };
  const ref = indexedTag(tags, item), tag = ref?.quote;
  if (!tag || tag.length > 1000) return null;
  const attrs = parse(tag);
  return attrs?.get('name') === item.name && attrs.get('value') === item.value &&
    attrs.get('data-option-name') === item.text && attrs.has('checked') && !attrs.has('disabled') ? ref : null;
}

// Match parser ordinals against the original document, including excluded regions.
// A count disagreement means serialization cannot safely be tied to the parser.
function indexedTag(tags, item) {
  return Number.isSafeInteger(item.tagOrdinal) && item.tagOrdinal >= 0 &&
    item.tagCount === tags.length && item.tagOrdinal < tags.length ? tags[item.tagOrdinal] : null;
}

function rawTagIndex(html) {
  const inputs = [...html.matchAll(/<input\b[^>]*>/gi)].map(match => ({ quote: match[0], offset: match.index }));
  const prices = [], stack = [];
  for (const match of html.matchAll(/<\/?sale-price\b[^>]*>/gi)) {
    if (/^<\//.test(match[0])) {
      const open = stack.pop();
      if (open && stack.length === 0 && !open.nested && match.index + match[0].length - open.start <= 1000)
        prices[open.ordinal] = { quote: html.slice(open.start, match.index + match[0].length), offset: open.start };
    } else {
      if (stack.length) stack.at(-1).nested = true;
      const open = { ordinal: prices.length, start: match.index, nested: stack.length > 0 };
      prices.push(null);
      stack.push(open);
    }
  }
  return { inputs, prices };
}

// Retain the original element so the amount is visibly tied to a sale price.
function salePriceQuote(tags, item) {
  if (item.tag !== 'sale-price' || !/\d/.test(item.text)) return null;
  const ref = indexedTag(tags, item), quote = ref?.quote;
  if (!quote) return null;
  const match = quote.match(/^<sale-price\b[^>]*>([\s\S]*?)<\/sale-price\s*>$/i);
  if (!match || !/^(?:[^<&]|<span(?:\s[^<>]*)?>|<\/span\s*>)*$/i.test(match[1])) return null;
  const compact = text => text.replace(/\s+/g, '');
  return compact(match[1].replace(/<\/?span(?:\s[^<>]*)?>/gi, '')) === compact(item.text) ? ref : null;
}

// Category guidance is supplied to the same model call as the product evidence.
// Unknown categories use the generic rule rather than an unrelated template.
const categoryGuide = field => categories.categories.map(category => {
  const values = category[field].map(attribute => `${attribute.label}: ${attribute.full}${attribute.condition ? ` (when ${attribute.condition})` : ''}`).join('; ');
  return `${category.name} (${category.scope}): ${values}`;
}).join(' | ');
const limitationGuide = categories.categories.map(category => {
  const rule = category.decisionSupport.find(item => item.subcheckId === 'C4.limitations');
  return `${category.name}: ${rule.full} Condition: ${rule.condition}`;
}).join(' | ');
const contentRules = {
  'C2.essential': `Identify the primary product category from its evidence. For a matching category, pass only when its essential attributes are explicitly specified for the product or selected variant: ${categoryGuide('essentialAttributes')}. For other categories, pass only when the important identifying specifications for that product type are explicit. Do not infer missing values.`,
  'C2.supporting': `Identify the primary product category from its evidence. For a matching category, pass when the relevant supporting attributes are specifically disclosed: ${categoryGuide('supportingAttributes')}. For other categories, assess the relevant supporting specifications for that product type. Specific applicable care is sufficient for the care portion. Do not require drying instructions or repeat essential specifications. Do not infer missing values.`,
  'C4.limitations': `Assess product-specific limitations or exclusions, taking the category and claims into account: ${limitationGuide}. For other categories, require an applicable specific restriction or boundary. Do not infer an absent limitation.`,
  'C5.consistency': 'Pass only if there is sufficient comparable evidence about the same product and configuration and no material contradiction. Fail for a material contradiction or insufficient comparable evidence. Do not treat differences between variants or equivalent units as contradictions. In evidenceIds cite the two distinct observations you compared, and describe their agreement or conflict in the reason.',
  'C5.claim-support': 'Pass only when material product claims are supported or appropriately qualified by relevant product evidence. Fail when support is missing, incomplete, contradicted, or the evidence is insufficient to assess the claims. Distinguish specific claims from ordinary descriptive facts. Cite the material claim first and a separate supporting, qualifying, or contradicting observation second when available. Repetition of a claim is not support.',
};

const ambiguousProductUi = /\brole\s*=\s*["']?dialog\b|bopis|store[-_ ]?pickup|pickup[-_ ]?availability|quick[-_ ]?(?:add|buy)|wishlist|store[-_ ]?locator|\b(?:id|class|role)\s*=\s*(?:"[^"]*&#|'[^']*&#|[^\s>]*&#)/i;

function namedProductDetails(productHtml, name, renderedHtml) {
  const source = productHtml.sourceObservation;
  // The source observation lacks ancestry for these UI markers. Keep the
  // primary-region quotes only when a supplemental section might include one.
  if (!source?.complete || source.regions !== 1 || ambiguousProductUi.test(renderedHtml)) return [];
  const normalized = value => value.toLowerCase().replace(/\s+/g, ' ').trim();
  const labels = new Set([normalized(name), normalized(name.split(/\s+[|–—-]\s+/)[0])]);
  const ordinal = item => Number(/^html:element:(\d+)$/.exec(item.location)?.[1]);
  const headings = productHtml.headings ?? [];
  const sections = (source.headings ?? []).filter(heading => heading.level > 1 && labels.has(normalized(heading.text)
    .replace(/ (?:product description|product details|product specifications|specifications)$/, '')) &&
    / (?:description|details|specifications)$/i.test(heading.text));
  if (sections.length !== 1) return [];
  const start = ordinal(sections[0]);
  const end = Math.min(start + 80, ...headings.map(ordinal).filter(value => value > start));
  return (source.blocks ?? []).filter(block => ordinal(block) > start && ordinal(block) < end);
}

export async function prepareKeyedAudit(auditId, input, derived, { legacy = false } = {}) {
  const { snapshot, extracted, source } = input;
  const bundle = await prepareAssessmentSources(snapshot, extracted);
  if (!bundle.coverage.preparedHtml || !bundle.coverage.complete || !derived) throw fail('invalid_prepared_input');

  const productSources = bundle.sources.filter(item => item.scope === 'product' && item.origin === 'rendered');
  // Raw offsets use JavaScript string units. All product sections in a
  // prepared bundle are consecutive slices of this same rendered document.
  let sectionOffset = 0;
  const productSections = productSources.map(item => {
    const start = sectionOffset;
    sectionOffset += item.text.length;
    return { item, start, end: sectionOffset };
  });
  const scoped = derived.productHtml?.keyedPrimary ?? [];
  const names = [...new Set(scoped.filter(item => item.tag === 'h1').map(item => item.text))];
  const rawTags = scoped.some(item => Number.isSafeInteger(item.tagCount))
    ? rawTagIndex(snapshot.browser.renderedHtml) : { inputs: [], prices: [] };
  const evidence = [];
  const seen = new Set();
  function add(kind, candidate) {
    const quote = typeof candidate === 'string' ? candidate : candidate?.quote;
    if (typeof quote !== 'string' || !quote.trim() || quote.length > 1000 || seen.has(kind + quote)) return;
    const offset = candidate?.offset;
    const exact = typeof offset === 'number'
      ? productSections.find(({item, start, end}) => start <= offset && offset + quote.length <= end &&
        item.text.startsWith(quote, offset - start))?.item
      : productSources.find(item => item.text.includes(quote));
    if (!exact) return;
    evidence.push({ id: 'e' + (evidence.length + 1), kind, scope: 'product', sourceId: exact.id, quote });
    seen.add(kind + quote);
  }
  const primaryName = names.length === 1 ? names[0] : null;
  if (primaryName) {
    const apparel = /\b(?:shorts?|pants|trousers|jeans|shirts?|tees?|sweater|dress|jacket|skirt|hoodie|leggings)\b/i.test(primaryName);
    add('heading', primaryName);
    add('title', derived.productHtml.identity?.title || derived.title);
    for (const item of scoped) {
      const { tag, text } = item;
      if (item.kind === 'selected-option') {
        add('observed_option', selectedOptionQuote(rawTags.inputs, item));
        continue;
      }
      if (/^(?:summary|h[2-6])$/.test(tag)) {
        const label = text.replace(/[+−-]\s*$/, '').trim();
        if (/^(?:description|overview|about this product)$/i.test(label)) add('description_heading', label);
        if (/^(?:details|specifications|product details)$/i.test(label)) add('details_heading', label);
        continue;
      }
      const field = text.match(/^(material(?:s)?|composition|ingredients|dimension(?:s)?|fit|size|detail(?:s)?|construction|care|model|brand|compatibility)\s*:\s*(.+)$/i);
      if (field) {
        const name = field[1].toLowerCase(), value = field[2];
        if (apparel && /^(?:materials?|composition)$/.test(name) && /\d+(?:\.\d+)?%/.test(value))
          add('composition', value);
        if (apparel && name === 'fit') {
          add('fit', value);
          if (/\bfit\b/i.test(value) && /\d/.test(value) && /(?:["″]|\b(?:inches|inch|cm|mm)\b)/i.test(value))
            add('fit_dimension', value);
        }
        if (/^(?:details?|construction)$/.test(name)) add('construction', value);
        if (name === 'care') add('care', value);
        if (apparel && name === 'model' && /\bwear(?:s|ing) size\b/i.test(value)) add('size_reference', value);
        if (name === 'brand') add('brand', value);
        if (name === 'compatibility') add('compatibility', value);
      } else if (tag === 'p' && text.length >= 40 &&
          !/\b(?:returns?|shipping|review|find a store|pickup)\b/i.test(text)) {
        add('description', text);
      } else if (tag === 'sale-price' && /\d/.test(text)) {
        const quote = salePriceQuote(rawTags.prices, item);
        add('price', quote);
        // A currency symbol alone is not an ISO currency.
        if (/\b(?:USD|CAD|GBP|EUR|AUD|NZD)\b/.test(text)) add('currency', quote);
      }
    }
    const product = primaryProductData(derived.jsonLd, primaryName, snapshot.url);
    const brand = product?.brand;
    if (typeof brand?.name === 'string') add('brand', '"brand":' + JSON.stringify(brand));
    if (typeof brand === 'string') add('brand', '"brand":' + JSON.stringify(brand));

  }

  if (!legacy && primaryName) {
    // Use the primary product region and a uniquely named description section
    // from the complete source observation. Keep exact prepared quotations.
    const baseCount = evidence.length;
    const primaryFacts = scoped.filter(item => /^(?:p|li|dt|dd)$/.test(item.tag));
    const namedFacts = namedProductDetails(derived.productHtml, primaryName, snapshot.browser.renderedHtml);
    const productFacts = [...primaryFacts.slice(0, 6), ...namedFacts, ...primaryFacts.slice(6)];
    for (const item of productFacts) {
      if (evidence.length - baseCount >= 24) break;
      if (item.text.length <= 500 &&
          !/\b(?:returns?|shipping|reviews?|find a store|pickup)\b/i.test(item.text)) {
        add('product_fact', item.text);
      }
    }
  }
  const newPolicies = { ...policies,
    'C2.essential': ['product_fact'], 'C2.supporting': ['product_fact'],
    'C4.limitations': ['product_fact'], 'C5.consistency': ['product_fact'],
    'C5.claim-support': ['product_fact'] };
  const categoryEvidenceIds = evidence.filter(item => item.kind === 'heading').map(item => item.id);
  const factIds = evidence.filter(item => item.kind === 'product_fact').map(item => item.id);
  function makeFixture(factLimit) {
    const questions = Object.entries(legacy ? policies : newPolicies).map(([id, passKinds]) => ({
      id, passRule: (!legacy && contentRules[id]) || questionRules[id] || rubricChecks.get(id).full, passKinds,
      eligibleEvidenceIds: !legacy && contentRules[id]
        ? [...categoryEvidenceIds, ...factIds.slice(0, factLimit)]
        : evidence.filter(item => passKinds.includes(item.kind) ||
          (id === 'C1.configuration' && item.kind === 'observed_option')).slice(0, 8).map(item => item.id),
    }));
    const selected = new Set(questions.flatMap(question => question.eligibleEvidenceIds));
    return { ...(!legacy ? { requestVersion: 3 } : {}), capture: { auditId, sha256: source.preparedHash },
      sources: productSources, evidence: legacy ? evidence : evidence.filter(item => selected.has(item.id)), questions,
      ...(categoryEvidenceIds.length ? { categoryEvidenceIds } : {}) };
  }
  let limit = factIds.length;
  let fixture = makeFixture(limit), benchmark;
  for (;;) {
    try { benchmark = prepareBinaryBenchmark(fixture); break; }
    catch (error) {
      if (legacy || !(error instanceof RangeError) || error.message !== 'request_limit' || !limit) throw error;
      // Reduce only the additional facts. Existing questions retain their evidence.
      limit = Math.floor(limit / 2);
      fixture = makeFixture(limit);
    }
  }
  const inputDigest = await digest(JSON.stringify([source.preparedHash, benchmark.body, benchmark.questions]));
  return { input, bundle, fixture, benchmark, inputDigest };
}

function recordAnswers(benchmark, output) {
  const results = Array.isArray(output?.results) ? null : output?.results;
  const sentEvidence = new Set(benchmark.questions.flatMap(question => question.eligibleEvidenceIds));
  const findings = benchmark.questions.map(({id, maxPoints}) => {
    const result = results && Object.hasOwn(results, id) ? results[id] : null;
    const answer = ['pass', 'fail'].includes(result?.answer) ? result.answer : null;
    const reason = typeof result?.reason === 'string' ? [...result.reason].slice(0, 300).join('') : null;
    const citations = Array.isArray(result?.evidenceIds) ? result.evidenceIds : [];
    const evidenceIds = [...new Set(citations.filter(id => sentEvidence.has(id)))].slice(0, 2);
    const evidence = evidenceIds.map(id => benchmark.evidenceById.get(id));
    return {id, maxPoints, answer, reason, evidenceIds, evidence,
      validation: answer ? 'recorded' : result ? 'invalid_answer' : 'missing_answer',
      points: answer === 'pass' ? maxPoints : answer === 'fail' ? 0 : null};
  });
  const measured = findings.filter(finding => finding.answer).length;
  const earnedPoints = findings.reduce((sum, finding) => sum + (finding.points ?? 0), 0);
  const unmeasured = findings.length - measured;
  return {findings, measured, unmeasured, earnedPoints,
    status: unmeasured ? 'incomplete' : 'complete', score: unmeasured ? null : earnedPoints};
}

async function storedAssessment(prepared, store, output) {
  const rows = await store.readQuestions(attempt(prepared));
  const keys = new Set(prepared.benchmark.questions.map(question => question.id));
  const label = typeof output?.category?.label === 'string' ? output.category.label.trim().slice(0, 160) : null;
  return {category: label || null, findings: rows.filter(row => keys.has(row.question_id)).map(row => ({
    id: row.question_id, answer: row.answer, reason: row.reason, evidence: JSON.parse(row.evidence_json)
  }))};
}

async function retainedOutput(prepared, store) {
  const saved = await store.read(attempt(prepared));
  if (!saved || saved.prepared_hash !== prepared.fixture.capture.sha256 || saved.response_schema_version !== prepared.benchmark.responseSchemaVersion ||
      !['received', 'complete', 'incomplete'].includes(saved.status) || !saved.response_body_base64 || saved.response_truncated ||
      !['response_received', 'model_output_invalid'].includes(saved.outcome) ||
      !(saved.http_status >= 200 && saved.http_status < 300)) return null;
  try {
    const bytes = Uint8Array.from(atob(saved.response_body_base64), ch => ch.charCodeAt(0));
    const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const result = envelope.result;
    if (envelope.success !== true || envelope.errors?.length) return null;
    const choice = result?.choices?.[0];
    const finish = result?.finish_reason ?? choice?.finish_reason;
    if (saved.outcome === 'model_output_invalid' && finish !== 'length') return null;
    const output = JSON.parse(result?.response ?? choice?.message?.content);
    if (saved.status === 'received') {
      const report = recordAnswers(prepared.benchmark, output);
      const finish = () => retryModelWrite(() => store.finish(saved.attempt_id, report));
      try {
        await finish();
      } catch (error) {
        // A previous Worker can stop after storing its old scoring digest.
        // Keep the provider reply and replace only the unfinished projection.
        if (error.message !== 'model_results_conflict' ||
            !await store.resetUnfinishedResults(saved.attempt_id, saved.results_digest)) throw error;
        await finish();
      }
    }
    return output;
  } catch { return null; }
}

async function prepareForExistingAttempt(db, auditId, input, derived) {
  const prefix = attemptPrefix(auditId);
  const saved = await db.prepare(`SELECT response_schema_version FROM model_attempts
    WHERE attempt_id>=?1 AND attempt_id<?2 AND prepared_hash=?3 ORDER BY created_at DESC LIMIT 1`)
    .bind(prefix + '-', prefix + '.', input.source.preparedHash).first();
  return prepareKeyedAudit(auditId, input, derived, { legacy: saved?.response_schema_version === 2 });
}

export async function recoverKeyedAuditAssessment({ db, auditId, input, derived }) {
  const prepared = await prepareForExistingAttempt(db, auditId, input, derived);
  const store = createGraniteResponseStore(db);
  const output = await retainedOutput(prepared, store);
  return output ? storedAssessment(prepared, store, output) : null;
}

export async function runKeyedPreparedAudit({ env, auditId, input, derived, jobs, grant, allowance, now, fetch }) {
  const db = env.AUDIT_DB;
  const existing = await jobs.checkpointRead(grant, checkpoint);
  const prepared = existing ? await prepareForExistingAttempt(db, auditId, input, derived) : await prepareKeyedAudit(auditId, input, derived);
  const fixture = prepared.fixture;
  const expected = prepared.inputDigest;
  const store = createGraniteResponseStore(db);
  if (existing) {
    if (existing.inputDigest !== expected) throw fail('checkpoint_input_mismatch');
    if (existing.status === 'completed') return storedAssessment(prepared, store, existing.output);
    const saved = await retainedOutput(prepared, store);
    if (saved) return storedAssessment(prepared, store, saved);
    throw fail(existing.code ?? 'model_usage_uncertain');
  }
  const started = await jobs.checkpointStart(grant, checkpoint, expected);
  if (started.status !== 'started' || !started.created) throw fail('model_usage_uncertain');
  const result = await runBinaryBenchmark(fixture, { env, allowance, now, fetch, store, attemptId: attempt(prepared), scoreAnswers: recordAnswers });
  const output = result.output;
  if (output == null) {
    const code = result.failure ?? 'model_output_invalid';
    await jobs.checkpointFail(grant, checkpoint, code, { uncertain: result.inferenceRequests !== 0 });
    throw fail(code);
  }
  await jobs.checkpointComplete(grant, checkpoint, output);
  return storedAssessment(prepared, store, output);
}
