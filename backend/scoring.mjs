// Deterministic observations only. An unobserved field is not proof of absence.
import rubric from '../config/rubric.v1.json' with { type: 'json' };
import categories from '../config/categories.v1.1.json' with { type: 'json' };
import crawlerRegistry from '../config/crawlers.v1.json' with { type: 'json' };
import { scoreProductFields } from './product-fields.mjs';
import { selectProductVariant } from './product-variants.mjs';
import { assessWebsiteGuides } from './website-guides.mjs';
import { scoreProductLabels } from './product-labels.mjs';
import { scoreReference } from '../scripts/scoring-foundations.mjs';

const SUBCHECKS = rubric.criteria.flatMap(criterion => criterion.subchecks);
const maxPoints = Object.fromEntries(SUBCHECKS.map(check => [check.id, check.maxPoints]));
const CRAWLER_GROUPS = [
  ['S5.search', crawlerRegistry.scoring.search.botIds],
  ['S5.ai-retrieval', crawlerRegistry.scoring.aiRetrieval.botIds],
].map(([id, botIds]) => ({ id, bots: crawlerRegistry.bots.filter(bot => botIds.includes(bot.id)) }));

const PRODUCT_FIXES = {
  'S2.offer': {
    id: 'complete-structured-offer',
    title: 'Complete the structured offer',
    condition: 'If the associated offer supplies a valid price and currency and a recognized availability value.',
  },
  'S2.identifiers': {
    id: 'complete-structured-identifiers',
    title: 'Complete the structured brand and identifiers',
    condition: 'If the product has an applicable identifier and the associated record publishes it and the brand.',
  },
};

const schemaType = (types, type) => types.includes(type) || types.includes('https://schema.org/' + type) || types.includes('http://schema.org/' + type);
const SCHEMA_CONTEXTS = new Set(['https://schema.org', 'https://schema.org/', 'http://schema.org', 'http://schema.org/']);

/** Score supported observations from a bounded retrieved document. */
export function scoreAudit(snapshot, extracted, { category = null } = {}) {
  const checks = Object.fromEntries(SUBCHECKS.map(check => [check.id, { status: 'not_measured' }]));
  const evidence = [];
  let productName = null;
  let variant = null;
  const fixes = [];
  let currency = null;
  const sourceUrl = snapshot?.url;
  const observedAt = snapshot?.observedAt;
  const addEvidence = (url, location, excerpt) => {
    const item = { id: `e${evidence.length + 1}`, url, method: 'raw', kind: 'derived_observation',
      observedAt, location, excerpt };
    evidence.push(item);
    return item.id;
  };
  const scoreFields = (record, addFieldEvidence) => {
    for (const [checkId, field] of Object.entries(scoreProductFields(record, sourceUrl))) {
      const evidenceId = addFieldEvidence(field.excerpt);
      checks[checkId] = { status: 'measured', fraction: field.fraction, evidence: evidenceId };
      if (field.currency) currency = field.currency;
      if (field.fraction < 1) fixes.push({
        ...PRODUCT_FIXES[checkId], owner: 'Web developer', checkIds: [checkId],
        evidenceIds: [evidenceId], recoverablePoints: maxPoints[checkId] * (1 - field.fraction),
      });
    }
  };
  // A Product JSON-LD record proves a parseable entity, but its association with
  // the selected product is ambiguous without additional page context.
  const scripts = Array.isArray(extracted?.jsonLd) ? extracted.jsonLd : [];
  const products = [];
  const groups = [];
  let scriptsComplete = Array.isArray(extracted?.jsonLd) && scripts.length < 100 && extracted?.coverage?.jsonLdTruncated === false;
  for (const [index, script] of scripts.entries()) {
    if (typeof script !== 'string' || script.length >= 8192) { scriptsComplete = false; continue; }
    let records, context, graphContainer;
    try {
      const parsed = JSON.parse(script);
      context = parsed?.['@context'];
      graphContainer = Array.isArray(parsed?.['@graph']) ? parsed : null;
      if (parsed && Object.hasOwn(parsed, '@context') && !SCHEMA_CONTEXTS.has(context)) scriptsComplete = false;
      records = Array.isArray(parsed) ? parsed : [parsed, ...(Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [])];
    } catch { scriptsComplete = false; continue; }
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      if (['@included', '@nest', '@reverse'].some(key => Object.hasOwn(record, key)) ||
          (record !== graphContainer && Object.hasOwn(record, '@graph'))) scriptsComplete = false;
      const types = [record['@type']].flat();
      const ownsContext = Object.hasOwn(record, '@context');
      const effectiveContext = ownsContext ? record['@context'] : context;
      if (ownsContext && !SCHEMA_CONTEXTS.has(effectiveContext)) scriptsComplete = false;
      const isGroup = schemaType(types, 'ProductGroup');
      if (!isGroup && !schemaType(types, 'Product')) continue;
      if (!SCHEMA_CONTEXTS.has(effectiveContext)) { scriptsComplete = false; continue; }
      if (isGroup) groups.push({ record, index });
      else products.push({ record, index });
    }
  }
  if (products.length && typeof sourceUrl === 'string' && typeof snapshot?.observedAt === 'string') {
    const addProductEvidence = (index, excerpt) =>
      addEvidence(sourceUrl, `script[type="application/ld+json"] at extracted index ${index}`, excerpt);
    const id = addProductEvidence(products[0].index, 'Product');
    checks['S2.entity'] = { status: 'measured', fraction: 0.5, evidence: id };
    // Score properties only for an explicitly associated schema.org Product.
    // Non-string and short values are ambiguous rather than confirmed omissions.
    if (scriptsComplete && products.length === 1 && groups.length === 0) {
      const { record, index } = products[0];
      let associated = false;
      try {
        associated = typeof record.url === 'string' && new URL(record.url, sourceUrl).href === new URL(sourceUrl).href &&
          !['@id', 'hasVariant', 'isVariantOf', 'variesBy'].some(key => Object.hasOwn(record, key));
      } catch { /* Unknown context or URL does not establish association. */ }
      const meaningful = (value, minimum) => typeof value === 'string' && value.trim().length >= minimum && /[\p{L}\p{N}]/u.test(value);
      const validImage = value => {
        if (typeof value !== 'string' || !value.trim()) return false;
        try { return ['http:', 'https:'].includes(new URL(value, sourceUrl).protocol); } catch { return false; }
      };
      const values = { name: meaningful(record.name, 3), description: meaningful(record.description, 20),
        image: validImage(record.image) || (Array.isArray(record.image) && record.image.length > 0 && record.image.every(validImage)) };
      if (associated && values.name) {
        productName = record.name.trim().slice(0, 160);
        evidence[0].excerpt = 'One schema.org Product explicitly identifies the audited URL.';
        checks['S2.entity'] = { status: 'measured', fraction: 1, evidence: id };
      }
      const present = Object.keys(values).filter(key => values[key]);
      const missing = Object.keys(values).filter(key => !Object.hasOwn(record, key));
      if (associated && present.length + missing.length === 3) {
        const excerpt = `Product properties present: ${present.join(', ') || 'none'}${missing.length ? `; absent from record: ${missing.join(', ')}` : ''}.`;
        const coreId = addProductEvidence(index, excerpt);
        const fraction = present.length / 3;
        checks['S2.core-properties'] = { status: 'measured', fraction, evidence: coreId };
        if (missing.length && productName) fixes.push({
          id: 'publish-structured-product-properties',
          title: 'Complete the structured product properties',
          owner: 'Web developer', checkIds: ['S2.core-properties'], evidenceIds: [coreId],
          recoverablePoints: 2 - 2 * fraction,
          condition: `If the same audited Product record supplies meaningful ${missing.join(', ')} values and its association remains clear.`,
        });
      }
      if (associated && values.name) {
        for (const [checkId, label] of Object.entries(scoreProductLabels(record, extracted.labelEvidence))) {
          const evidenceId = addEvidence(sourceUrl, label.location, label.excerpt);
          checks[checkId] = { status: 'measured', fraction: label.fraction, evidence: evidenceId };
        }
        scoreFields(record, excerpt => addProductEvidence(index, excerpt));
      }
    }
  }
  if (scriptsComplete && groups.length === 1 && products.length === 0 &&
      typeof sourceUrl === 'string' && typeof observedAt === 'string') {
    const { record, index } = groups[0];
    const selected = selectProductVariant(record, sourceUrl);
    if (selected) {
      const location = `script[type="application/ld+json"] at extracted index ${index}; ProductGroup hasVariant[${selected.selectedIndex}]`;
      const variantEvidence = addEvidence(sourceUrl, location, selected.evidence.excerpt);
      checks['S2.variants'] = { status: 'measured', fraction: selected.evidence.fraction, evidence: variantEvidence };
      variant = selected.variant;
      scoreFields(selected.record, excerpt => addEvidence(sourceUrl, location, excerpt));
    }
  }
  if (checks['S2.entity'].fraction === 0.5) fixes.push({
    id: 'verify-product-association', title: 'Verify the structured product matches the audited page',
    owner: 'Web developer', checkIds: ['S2.entity'], evidenceIds: ['e1'], recoverablePoints: null,
    condition: 'Recovery cannot be calculated until the association is assessed.',
  });

  const crawlerPolicy = snapshot?.crawlerPolicy;
  if (crawlerPolicy?.version === crawlerRegistry.version && crawlerPolicy.httpStatus === 200 && Array.isArray(crawlerPolicy.observations) &&
      typeof crawlerPolicy.url === 'string' && typeof observedAt === 'string') {
    const blocked = [];
    let recoverablePoints = 0;
    for (const { id, bots } of CRAWLER_GROUPS) {
      const statuses = bots.map(bot => {
        const observations = crawlerPolicy.observations.filter(observation => observation?.botId === bot.id);
        return observations.length === 1 ? observations[0].status : null;
      });
      if (!bots.length || !statuses.every(status => status === 'allowed' || status === 'disallowed')) continue;
      const fraction = statuses.filter(status => status === 'allowed').length / bots.length;
      const summary = bots.map((bot, index) => `${bot.name}: ${statuses[index]}`).join(', ');
      const evidenceId = addEvidence(crawlerPolicy.url, 'robots.txt policy for the final product URL', summary);
      checks[id] = { status: 'measured', fraction, evidence: evidenceId };
      if (fraction < 1) {
        blocked.push({ id, evidenceId });
        recoverablePoints += maxPoints[id] * (1 - fraction);
      }
    }
    if (blocked.length) fixes.push({
      id: 'review-product-crawler-access', title: 'Review crawler access to the product page',
      owner: 'Web developer', checkIds: blocked.map(check => check.id),
      evidenceIds: blocked.map(check => check.evidenceId), recoverablePoints,
      condition: 'If the site intends to permit these crawlers and its effective robots policy allows them on the audited URL.',
    });
  }
  const sitemap = snapshot?.sitemap;
  if (sitemap && typeof observedAt === 'string') {
    for (const [id, url, location, excerpt] of [
      ['S6.usable', sitemap.usableSource, 'sitemap XML document',
        'A bounded same-origin sitemap inspection verified a parseable URL listing.'],
      ['S6.inclusion', sitemap.inclusionSource, 'sitemap XML url/loc',
        'A sitemap URL entry exactly matches the final audited product URL.'],
    ]) {
      if (typeof url !== 'string' || !url) continue;
      checks[id] = { status: 'measured', fraction: 1, evidence: addEvidence(url, location, excerpt) };
    }
  }
  if (snapshot?.guides && typeof sourceUrl === 'string' && typeof observedAt === 'string') {
    for (const [id, finding] of Object.entries(assessWebsiteGuides(snapshot.guides, sourceUrl))) {
      checks[id] = { status: 'measured', fraction: finding.fraction,
        evidence: addEvidence(finding.url, finding.location, finding.excerpt) };
    }
  }
  fixes.sort((a, b) => (b.recoverablePoints ?? -1) - (a.recoverablePoints ?? -1));

  const reference = scoreReference(rubric, categories, { category, checks });
  const criteria = rubric.criteria.map(c => ({
    id: c.id, pillar: c.pillar, maxPoints: c.maxPoints,
    points: reference.criteria[c.id].points,
    complete: reference.criteria[c.id].complete,
    subchecks: c.subchecks.map(s => {
      const check = checks[s.id];
      return { id: s.id, maxPoints: s.maxPoints, status: check.status,
        fraction: check.fraction ?? null, points: check.status === 'measured' ? s.maxPoints * check.fraction : null,
        evidenceIds: check.evidence ? [check.evidence] : [],
        reason: check.status === 'not_measured' ? 'Available evidence does not establish this check.' : null };
    })
  }));
  const allChecks = criteria.flatMap(c => c.subchecks);
  return {
    status: reference.status,
    score: reference.status === 'complete' ? {
      total: reference.finalScore,
      structure: criteria.filter(c => c.pillar === 'structure').reduce((sum, c) => sum + c.points, 0),
      content: criteria.filter(c => c.pillar === 'content').reduce((sum, c) => sum + c.points, 0)
    } : null,
    earnedPoints: reference.earnedPoints, rubricVersion: rubric.version,
    category: categories.categories.some(c => c.id === category) ? category : null,
    productName, variant, market: null, currency,
    criteria, evidence, fixes,
    coverage: { measured: allChecks.filter(c => c.status === 'measured').length,
      notMeasured: allChecks.filter(c => c.status === 'not_measured').length,
      total: allChecks.length, category: categories.categories.some(c => c.id === category) ? category : null,
      extraction: extracted?.coverage ?? null,
      limitations: [...(extracted?.limitations ?? []), 'Semantic assessment, rendering, and unobserved evidence are not scored.'] }
  };
}
