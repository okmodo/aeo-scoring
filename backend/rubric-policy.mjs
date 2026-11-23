// Convert the existing policy observations to the v3 all-or-nothing checks.
// The observations carry source excerpts; a model's score alone is not proof.
const unknown = reason => ({ status: 'not_measured', reason });
const binaryItemGroups = {
  'C2.essential': 'attributes', 'C2.supporting': 'attributes',
  'C4.intended-use': 'questions', 'C4.compatibility': 'questions',
  'C4.limitations': 'questions', 'C4.selection': 'questions',
  'C5.consistency': 'comparisons', 'C5.claim-support': 'claims',
};
const binarySingleChecks = ['C1.identity', 'C1.explanation', 'C1.configuration', 'C3.price', 'C3.availability'];

export function enforceBinaryContent(checks) {
  for (const id of binarySingleChecks)
    if (checks[id]?.status === 'measured' && ![0, 1].includes(checks[id].fraction))
      checks[id] = unknown('The evidence did not establish a verified pass or fail for this question.');
  for (const [id, key] of Object.entries(binaryItemGroups)) {
    const finding = checks[id];
    if (finding?.status !== 'measured') continue;
    const items = finding[key]?.filter(item => item.status !== 'not_applicable') ?? [];
    const shopperVisible = item => {
      const refs = item.evidence ?? item.observations ?? [];
      return refs.length >= 2 && refs.every(ref => (!ref.scope || ref.scope === 'product') &&
        !/structured product|json.?ld|application\/ld\+json/i.test(ref.location || ''));
    };
    if (!items.length || items.some(item => ![0, 1].includes(item.fraction) ||
        (item.status && item.status !== 'measured') || (id === 'C5.consistency' && !shopperVisible(item)))) {
      checks[id] = { ...finding, status: 'not_measured', fraction: null,
        reason: 'At least one applicable item lacks an evidence-backed binary result.' };
      continue;
    }
    checks[id] = { ...finding, fraction: items.reduce((sum, item) => sum + item.fraction, 0) / items.length };
  }
}

const patterns = {
  shipping: [
    /\b(?:ships?|shipping|deliver(?:y|s)?)\s+(?:(?:to|within)\s+(?:the\s+)?[a-z]|nationwide\b|domestically\b|internationally\b)/i,
    /\b(?:free shipping|shipping (?:is free|(?:cost|fee|rate)s?\s*(?:is|are|:|\$|\d|calculated))|calculated at checkout)\b/i,
    /\b(?:deliver(?:y|ed|s)?|arriv(?:al|es?))[^.!?]{0,60}\b\d+\s*(?:(?:to|-|–)\s*\d+\s*)?(?:business\s+)?days?\b/i,
  ],
  returns: [
    /\b(?:unused|unworn|unopened|original condition|eligible items?)\b/i,
    /\b(?:within|up to)\s*\d+\s*days?\b/i,
    /\b(?:original packaging|return shipping|refund(?:ed|s)?\s+(?:to|go)|restocking fee)\b/i,
  ],
};
const contextual = /\b(?:other|different|another)\s+(?:products?|items?|orders?)\b|\b(?:except|excludes?|excluding|not applicable|may not apply|restrictions apply|select items?|some items?|not all products?|not all items?|not all orders?)\b/i;
const unsafe = /\b(?:ignore (?:all )?(?:previous |prior )?instructions|system prompt|give (?:full|maximum) (?:credit|points))\b/i;
const supported = evidence => evidence && typeof evidence.url === 'string' && /^https?:\/\//i.test(evidence.url) &&
  typeof evidence.location === 'string' && evidence.location.trim() && typeof evidence.excerpt === 'string' && evidence.excerpt.trim() &&
  !contextual.test(evidence.excerpt) && !unsafe.test(evidence.excerpt);

// Only directly product-scoped statements are eligible for these special cases.
const productScope = /\b(?:this (?:product|item)|all (?:products|items|orders))\b/i;
const pickupOnly = /\bthis (?:product|item)\s+is\s+(?:available|offered)\s+(?:for\s+)?(?:in[ -]store\s+)?pickup\s+only\b/i;
const finalSale = /\bthis (?:product|item)\s+is\s+final sale\b/i;
const missingTerms = {
  shipping: /\b(?:shipping (?:destinations?|coverage|costs?|fees?|rates?)|delivery (?:times?|estimates?|guidance))\s+(?:is|are)\s+(?:not (?:provided|specified|stated|available)|unspecified)\b/i,
  returns: /\b(?:return (?:eligibility|window|period|conditions?))\s+(?:is|are)\s+(?:not (?:provided|specified|stated|available)|unspecified)\b/i,
};
const sameOrigin = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };
function retainedSources(snapshot, extracted, kind) {
  const html = extracted?.productHtml;
  const source = snapshot?.url;
  const rawProduct = [...(html?.blocks || []), ...(html?.headings || [])];
  const productComplete = html?.complete === true && !html.truncated && !html.uninterpreted && !snapshot?.htmlLimited &&
    !snapshot?.browser?.coverage?.renderedLimited && Array.isArray(html.blocks) && rawProduct.every(b => typeof b?.text === 'string' && !unsafe.test(b.text));
  const policy = snapshot?.policies?.[kind], policyBlocks = policy?.extraction?.blocks;
  const policyComplete = policy?.state === 'read' && sameOrigin(policy.url, source) && policy.extraction?.complete === true &&
    !policy.extraction?.truncated && !policy.extraction?.uninterpreted && Array.isArray(policyBlocks) &&
    policyBlocks.every(b => typeof b?.text === 'string' && !unsafe.test(b.text));
  const refs = (blocks, url, fallback) => blocks.filter(b => b.text.trim()).map(b => ({url, location: b.location || fallback, excerpt: b.text.slice(0, 500)}));
  return { productComplete, policyComplete, product: refs(rawProduct, source, 'product content'),
    policy: policyComplete ? refs(policyBlocks, policy.url, `${kind} policy`) : [] };
}

export function assessBinaryPolicy(kind, finding, { snapshot, extracted } = {}) {
  if (!Object.hasOwn(patterns, kind)) return unknown('Unsupported policy kind.');
  const retained = retainedSources(snapshot, extracted, kind);
  const productSpecial = retained.productComplete ? retained.product.filter(supported) : [];
  const pickup = kind === 'shipping' && productSpecial.find(item => pickupOnly.test(item.excerpt) &&
    /\b(?:shipping|delivery)\s+(?:is\s+)?(?:not available|unavailable)\b/i.test(item.excerpt));
  // Conflicting positive delivery statements make the exclusion uncertain.
  if (pickup && !/\b(?:ships?|delivers?)\s+(?:to|within)\b|\bfree shipping\b/i.test(pickup.excerpt) &&
      !retained.product.some(item => item !== pickup && /\b(?:ships?|shipping|delivery)\b/i.test(item.excerpt)))
    return { status: 'not_applicable', rule: 'pickup_only', justification: 'The product is explicitly available only for pickup and shipping is unavailable.', ...pickup };
  const final = kind === 'returns' && productSpecial.find(item => finalSale.test(item.excerpt));
  if (final) return { status: 'measured', fraction: 1, ...final, evidence: [final] };
  // A missing-term failure requires complete relevant sources plus an explicit
  // product-scoped statement of the absence; a regex miss is not proof.
  const policyScope = retained.policy.some(item => productScope.test(item.excerpt) && !contextual.test(item.excerpt));
  const missing = retained.productComplete && retained.policyComplete && policyScope &&
    retained.policy.find(item => productScope.test(item.excerpt) && missingTerms[kind].test(item.excerpt) && supported(item));
  if (missing) {
    const field = kind === 'shipping' ? (/\b(?:destinations?|coverage)\b/i.test(missing.excerpt) ? 0 : /\b(?:costs?|fees?|rates?)\b/i.test(missing.excerpt) ? 1 : 2) :
      (/\beligibility\b/i.test(missing.excerpt) ? 0 : /\b(?:window|period)\b/i.test(missing.excerpt) ? 1 : 2);
    const conflict = [...retained.product, ...retained.policy].some(item => item !== missing && patterns[kind][field].test(item.excerpt));
    if (!conflict) return { status: 'measured', fraction: 0, ...missing, evidence: [missing] };
  }
  if (!finding || finding.status !== 'measured') return unknown(finding?.reason || `The ${kind} policy was not established.`);
  // This legacy zero already requires complete inspection and verified absence.
  if (finding.fraction === 0 && supported(finding)) return { ...finding, fraction: 0 };
  const terms = Array.isArray(finding.policyTerms) ? finding.policyTerms : [];
  const evidence = terms.flatMap(term => Array.isArray(term?.evidence) ? term.evidence : []).filter(supported);
  const applicable = evidence.length > 0 && evidence.every(item => sameOrigin(item.url, snapshot?.url)) &&
    (evidence.some(item => productScope.test(item.excerpt)) || policyScope);
  const has = re => evidence.some(item => re.test(item.excerpt));
  const finalFinding = kind === 'returns' && evidence.some(item => finalSale.test(item.excerpt));
  if (applicable && (patterns[kind].every(has) || finalFinding)) {
    const refs = [...new Map(evidence.map(item => [`${item.url}\n${item.location}\n${item.excerpt}`, item])).values()];
    return { ...finding, fraction: 1, url: refs[0].url, location: refs[0].location, excerpt: refs[0].excerpt, evidence: refs };
  }
  return unknown(`The applicable ${kind} policy terms or complete coverage were not established.`);
}
