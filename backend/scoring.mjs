// Deterministic observations only. An unobserved field is not proof of absence.
import rubric from '../config/rubric.v1.json' with { type: 'json' };
import categories from '../config/categories.v1.1.json' with { type: 'json' };
import { scoreReference } from '../scripts/scoring-foundations.mjs';

/** Score a bounded inspectSnapshot result. Retrieval failure may be passed as null. */
export function scoreAudit(snapshot, extracted, { category = null } = {}) {
  const checks = Object.fromEntries(rubric.criteria.flatMap(c => c.subchecks.map(s => [s.id, { status: 'not_measured' }])));
  const evidence = [];
  const sourceUrl = snapshot?.url;
  // A Product JSON-LD record proves a parseable entity, but its association with
  // the selected product is ambiguous without additional page context.
  const scripts = Array.isArray(extracted?.jsonLd) ? extracted.jsonLd : [];
  const products = [];
  let scriptsComplete = Array.isArray(extracted?.jsonLd) && scripts.length < 100 && extracted?.coverage?.jsonLdTruncated === false;
  for (const [index, script] of scripts.entries()) {
    if (typeof script !== 'string' || script.length >= 8192) { scriptsComplete = false; continue; }
    let records;
    try {
      const parsed = JSON.parse(script);
      records = Array.isArray(parsed) ? parsed : [parsed, ...(Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [])];
    } catch { scriptsComplete = false; continue; }
    for (const record of records) {
      if (record && typeof record === 'object' && [record['@type']].flat().includes('Product')) products.push({ record, index });
    }
  }
  if (products.length && typeof sourceUrl === 'string' && typeof snapshot?.observedAt === 'string') {
    const location = index => `script[type="application/ld+json"] at extracted index ${index}`;
    const addEvidence = (index, excerpt) => {
      const item = { id: `e${evidence.length + 1}`, url: sourceUrl, method: 'raw', kind: 'derived_observation', observedAt: snapshot.observedAt,
        location: location(index), excerpt };
      evidence.push(item);
      return item.id;
    };
    const id = addEvidence(products[0].index, 'Product');
    checks['S2.entity'] = { status: 'measured', fraction: 0.5, evidence: id };
    // Score properties only for an explicitly associated schema.org Product.
    // Non-string and short values are ambiguous rather than confirmed omissions.
    if (scriptsComplete && products.length === 1) {
      const { record, index } = products[0];
      let associated = false;
      try {
        const context = JSON.parse(scripts[index])['@context'];
        associated = ['https://schema.org', 'https://schema.org/', 'http://schema.org', 'http://schema.org/'].includes(context) &&
          typeof record.url === 'string' && new URL(record.url, sourceUrl).href === new URL(sourceUrl).href &&
          !['@id', 'hasVariant', 'isVariantOf', 'variesBy'].some(key => Object.hasOwn(record, key));
      } catch { /* Unknown context or URL does not establish association. */ }
      const meaningful = (value, minimum) => typeof value === 'string' && value.trim().length >= minimum && /[\p{L}\p{N}]/u.test(value);
      const validImage = value => {
        if (typeof value !== 'string' || !value.trim()) return false;
        try { return ['http:', 'https:'].includes(new URL(value, sourceUrl).protocol); } catch { return false; }
      };
      const values = { name: meaningful(record.name, 3), description: meaningful(record.description, 20),
        image: validImage(record.image) || (Array.isArray(record.image) && record.image.length > 0 && record.image.every(validImage)) };
      const present = Object.keys(values).filter(key => values[key]);
      const missing = Object.keys(values).filter(key => !Object.hasOwn(record, key));
      if (associated && present.length + missing.length === 3) {
        const excerpt = `Product properties present: ${present.join(', ') || 'none'}${missing.length ? `; absent from record: ${missing.join(', ')}` : ''}.`;
        const coreId = addEvidence(index, excerpt);
        checks['S2.core-properties'] = { status: 'measured', fraction: present.length / 3, evidence: coreId };
      }
    }
  }
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
  const fixes = evidence.length ? [{
    id: 'verify-product-association', title: 'Verify the structured product matches the audited page',
    owner: 'Web developer', checkIds: ['S2.entity'], evidenceIds: ['e1'], recoverablePoints: null,
    condition: 'Recovery cannot be calculated until the association is assessed.'
  }] : [];
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
    productName: null, variant: null, market: null, currency: null,
    criteria, evidence, fixes,
    coverage: { measured: allChecks.filter(c => c.status === 'measured').length,
      notMeasured: allChecks.filter(c => c.status === 'not_measured').length,
      total: allChecks.length, category: categories.categories.some(c => c.id === category) ? category : null,
      extraction: extracted?.coverage ?? null,
      limitations: [...(extracted?.limitations ?? []), 'Semantic assessment, rendering, and unobserved evidence are not scored.'] }
  };
}
