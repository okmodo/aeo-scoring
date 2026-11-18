// Apply semantic judgments only where the underlying technical observation permits it.
// Network access, markup validity, link reachability, and exclusions remain local facts.
const technicalCaps = new Set([
  'S1.delivery', 'S1.readability', 'S1.configuration', 'S1.supporting-access',
  'S2.offer', 'S2.identifiers', 'S2.variants',
  'S3.price', 'S3.availability', 'S7.links', 'S8.guidance',
]);
const requireTechnicalMeasurement = new Set(['S1.delivery', 'S1.readability', 'S1.supporting-access', 'S2.entity', 'S2.offer', 'S2.identifiers', 'S2.variants', 'S3.price', 'S3.availability', 'S7.links', 'S8.guidance']);
const semanticChecks = new Set([
  'S1.delivery', 'S1.readability', 'S1.scope', 'S1.configuration', 'S1.supporting-access',
  'S2.entity', 'S2.offer', 'S2.identifiers', 'S2.variants',
  'S3.identity', 'S3.price', 'S3.availability', 'S3.optional-claims',
  'S4.title', 'S4.organization', 'S4.image-alternatives',
  'S7.identity', 'S7.links', 'S8.context', 'S8.guidance',
  'C1.identity', 'C1.explanation', 'C1.configuration', 'C2.essential', 'C2.supporting',
  'C3.price', 'C3.availability', 'C3.shipping', 'C3.returns',
  'C4.intended-use', 'C4.compatibility', 'C4.limitations', 'C4.selection',
  'C5.consistency', 'C5.claim-support',
]);

export function applyRubricAssessment(checks, assessment, { snapshot, extracted, addEvidence }) {
  const html = extracted?.productHtml;
  const complete = !snapshot?.htmlLimited && (html?.complete === true || Boolean(snapshot?.rawHtml));
  if (!complete) return;
  for (const [id, finding] of Object.entries(assessment.findings)) {
    if (!semanticChecks.has(id) || !Object.hasOwn(checks, id)) continue;
    if (finding.status === 'not_measured') {
      if ((checks[id].status !== 'not_applicable' || id.startsWith('C4.')) &&
          !((technicalCaps.has(id) || id === 'S2.entity') && checks[id].status === 'measured' && checks[id].fraction === 0))
        checks[id] = { status: 'not_measured', reason: finding.reason };
      continue;
    }
    if (!Array.isArray(finding.evidence) || !finding.evidence.length) {
      if (id.startsWith('C4.') && finding.status === 'not_applicable') checks[id] = { status: 'not_measured', reason: 'The conditional exclusion lacks evidence.' };
      continue;
    }
    if (finding.status === 'not_applicable' && id.startsWith('C4.') && finding.rule === 'category_conditions_absent') {
      const slots = assessment.profile?.slots?.filter(slot => slot.group === id) || [];
      const conditions = finding.conditions;
      if (!slots.length || slots.some(slot => slot.applicability !== 'conditional' || !slot.condition) ||
          !Array.isArray(conditions) || conditions.length !== slots.length ||
          new Set(conditions.map(item => item.questionId)).size !== slots.length ||
          slots.some(slot => !conditions.some(item => item.questionId === slot.id && item.condition === slot.condition &&
            item.status === 'absent' && item.evidence && item.location && item.method)) || !finding.justification) {
        checks[id] = { status: 'not_measured', reason: 'The conditional exclusion was not established.' };
        continue;
      }
      const ids = finding.evidence.map(ref => addEvidence(ref.url, ref.location, ref.excerpt));
      checks[id] = { ...finding, evidence: ids[0], evidenceIds: [...new Set(ids)] };
      continue;
    }
    if (finding.status === 'not_applicable' && id.startsWith('C4.')) {
      checks[id] = { status: 'not_measured', reason: 'The conditional exclusion rule is unsupported.' };
      continue;
    }
    if (finding.status === 'not_applicable' && id === 'C5.claim-support' && finding.rule === 'no_material_claims') {
      const ids = finding.evidence.map(ref => addEvidence(ref.url, ref.location, ref.excerpt));
      checks[id] = { ...finding, evidence: ids[0], evidenceIds: [...new Set(ids)] };
      continue;
    }
    const aggregate = id.startsWith('C2.') || id.startsWith('C4.') || id.startsWith('C5.');
    if (finding.status !== 'measured' || typeof finding.fraction !== 'number' ||
        !Number.isFinite(finding.fraction) || finding.fraction < 0 || finding.fraction > 1 ||
        (!aggregate && ![0, 0.5, 1].includes(finding.fraction))) continue;
    const prior = checks[id];
    if (prior.status === 'not_applicable' && !id.startsWith('C4.') && !id.startsWith('C5.')) continue;
    // A syntactically invalid or uninspected schema cannot be repaired by interpretation.
    if (id.startsWith('S2.') && (checks['S2.syntax']?.status !== 'measured' || checks['S2.syntax'].fraction < 1)) continue;
    if (requireTechnicalMeasurement.has(id) && prior.status !== 'measured') continue;
    if (id === 'S2.entity' && prior.status === 'measured' && prior.fraction === 0) continue;
    if ((id === 'S7.identity' || id === 'S8.context') &&
        (snapshot.guides?.[id.startsWith('S7') ? 'llmsState' : 'agentsState'] === 'absent' ||
         !snapshot.guides?.[id.startsWith('S7') ? 'llms' : 'agents']?.text?.trim())) continue;
    // A proven failure is binding; heuristic partial credit is not a technical ceiling.
    const hardCap = requireTechnicalMeasurement.has(id);
    const fraction = hardCap && prior.status === 'measured' ? Math.min(prior.fraction, finding.fraction) :
      technicalCaps.has(id) && prior.status === 'measured' && prior.fraction === 0 ? 0 : finding.fraction;
    const ids = finding.evidence.map(ref => addEvidence(ref.url, ref.location, ref.excerpt));
    checks[id] = { ...finding, fraction, evidence: ids[0], evidenceIds: [...new Set(ids)] };
  }
}
