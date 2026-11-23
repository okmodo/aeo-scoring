import rubric from '../config/rubric.v2.json' with { type: 'json' };
import { prepareBinaryBenchmark, runBinaryBenchmark, scoreBinaryBenchmark } from '../scripts/granite-binary-harness.mjs';
import { createGraniteResponseStore, retryModelWrite } from '../scripts/granite-response-store.mjs';
import { prepareAssessmentSources } from './assessment-sources.mjs';
import { validateRubricAssessment } from './ai-rubric-assessment.mjs';

const encoder = new TextEncoder();
const checkpoint = 'granite-keyed';
const attempt = ({ fixture, inputDigest }) => `granite-queue-${fixture.capture.auditId}-${inputDigest}`;
const fail = code => Object.assign(new Error(code), { code });
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
  byte => byte.toString(16).padStart(2, '0')).join('');
const rubricChecks = new Map(rubric.criteria.flatMap(criterion => criterion.subchecks.map(check => [check.id, check])));
const policies = {
  'S4.title': ['heading', 'title'],
  'S4.organization': ['description_heading', 'details_heading'],
  'C1.identity': ['heading', 'brand'],
  'C1.explanation': ['description'],
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

export async function prepareKeyedAudit(auditId, input, derived) {
  const { snapshot, extracted, source } = input;
  const bundle = await prepareAssessmentSources(snapshot, extracted);
  if (!bundle.coverage.preparedHtml || !bundle.coverage.complete || !derived) throw fail('invalid_prepared_input');

  const productSources = bundle.sources.filter(item => item.scope === 'product' && item.origin === 'rendered');
  const scoped = derived.productHtml?.keyedPrimary ?? [];
  const names = [...new Set(scoped.filter(item => item.tag === 'h1').map(item => item.text))];
  const evidence = [];
  const seen = new Set();
  function add(kind, quote) {
    if (typeof quote !== 'string' || !quote.trim() || quote.length > 1000 || seen.has(kind + quote)) return;
    const exact = productSources.find(item => item.text.includes(quote));
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
      } else if (tag === 'sale-price' && /\d/.test(text) && /\b(?:USD|CAD|GBP|EUR|AUD|NZD)\b/.test(text)) {
        // Keep amount and explicit currency tied to the same rendered offer.
        add('price', text);
        add('currency', text);
      }
    }
    const product = primaryProductData(derived.jsonLd, primaryName, snapshot.url);
    const brand = product?.brand;
    if (typeof brand?.name === 'string') add('brand', '"brand":' + JSON.stringify(brand));
    if (typeof brand === 'string') add('brand', '"brand":' + JSON.stringify(brand));

  }

  const questions = Object.entries(policies).map(([id, passKinds]) => ({
    id, passRule: questionRules[id] ?? rubricChecks.get(id).full, passKinds,
    eligibleEvidenceIds: evidence.filter(item => passKinds.includes(item.kind)).slice(0, 8).map(item => item.id),
  }));
  const categoryEvidenceIds = evidence.filter(item => item.kind === 'heading').map(item => item.id);
  const fixture = { capture: { auditId, sha256: source.preparedHash }, sources: productSources, evidence, questions,
    ...(categoryEvidenceIds.length ? { categoryEvidenceIds } : {}) };
  const benchmark = prepareBinaryBenchmark(fixture);
  const inputDigest = await digest(JSON.stringify([source.preparedHash, benchmark.body, benchmark.questions]));
  return { input, bundle, fixture, benchmark, inputDigest };
}

export function keyedAuditAssessment(prepared, output) {
  const { input, bundle, fixture, benchmark } = prepared;
  const measured = scoreBinaryBenchmark(benchmark, Array.isArray(output?.results) ? null : output);
  const byId = new Map(fixture.evidence.map(item => [item.id, item]));
  const category = output?.category;
  const categoryId = category?.evidenceId;
  const categoryRef = fixture.categoryEvidenceIds?.includes(categoryId) ? byId.get(categoryId) : null;
  const slots = fixture.questions.filter(question => /^(?:C2|C4)\./.test(question.id)).map(question => {
    const rule = rubricChecks.get(question.id);
    return { id: question.id.toLowerCase().replace('.', '-'), group: question.id, label: question.id,
      relevance: question.passRule, full: question.passRule, partial: rule.partial, zero: rule.zero,
      missingExpectation: rule.full };
  });
  const profile = categoryRef && typeof category.label === 'string' && category.label.trim() && category.label.length <= 160
    ? { category: category.label, evidence: [{ sourceId: categoryRef.sourceId, quote: categoryRef.quote }], slots, conditionReview: [] }
    : null;
  const slotIds = new Map(slots.map(slot => [slot.group, slot.id]));
  const judgments = measured.findings.filter(finding => finding.status === 'measured' && finding.answer === 'pass').map(finding => ({
    id: slotIds.get(finding.id) ?? finding.id, status: 'measured', fraction: 1, reason: finding.reason,
    evidence: finding.evidence.map(({ sourceId, quote }) => ({ sourceId, quote })),
  }));
  // Compact rendered coverage cannot prove omissions, exclusions, stock for an
  // unknown selection, or missing initial-source evidence.
  return validateRubricAssessment(bundle, profile, { judgments, c5: { claims: [], comparisons: [] } }, {
    snapshot: input.snapshot, extracted: input.extracted, inspections: [], supportInspections: [],
  });
}

async function retainedOutput(prepared, store) {
  const saved = await store.read(attempt(prepared));
  if (!saved || saved.prepared_hash !== prepared.fixture.capture.sha256 || saved.response_schema_version !== 2 ||
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
    if (saved.status === 'received') await retryModelWrite(() => store.finish(saved.attempt_id,
      scoreBinaryBenchmark(prepared.benchmark, output)));
    return output;
  } catch { return null; }
}

export async function recoverKeyedAuditAssessment({ db, auditId, input, derived }) {
  const prepared = await prepareKeyedAudit(auditId, input, derived);
  const output = await retainedOutput(prepared, createGraniteResponseStore(db));
  return output ? keyedAuditAssessment(prepared, output) : null;
}

export async function runKeyedPreparedAudit({ env, auditId, input, derived, jobs, grant, allowance, now, fetch }) {
  const prepared = await prepareKeyedAudit(auditId, input, derived);
  const fixture = prepared.fixture;
  const expected = prepared.inputDigest;
  const store = createGraniteResponseStore(env.AUDIT_DB);
  const existing = await jobs.checkpointRead(grant, checkpoint);
  if (existing) {
    if (existing.inputDigest !== expected) throw fail('checkpoint_input_mismatch');
    if (existing.status === 'completed') return keyedAuditAssessment(prepared, existing.output);
    const saved = await retainedOutput(prepared, store);
    if (saved) return keyedAuditAssessment(prepared, saved);
    throw fail(existing.code ?? 'model_usage_uncertain');
  }
  const started = await jobs.checkpointStart(grant, checkpoint, expected);
  if (started.status !== 'started' || !started.created) throw fail('model_usage_uncertain');
  const result = await runBinaryBenchmark(fixture, { env, allowance, now, fetch, store, attemptId: attempt(prepared) });
  const output = result.output;
  if (output == null) {
    const code = result.failure ?? 'model_output_invalid';
    await jobs.checkpointFail(grant, checkpoint, code, { uncertain: result.inferenceRequests !== 0 });
    throw fail(code);
  }
  await jobs.checkpointComplete(grant, checkpoint, output);
  return keyedAuditAssessment(prepared, output);
}
