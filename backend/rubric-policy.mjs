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
    /\b(?:return(?:s|ed)?|refund(?:s|ed)?)[^.!?]{0,100}\b(?:within|up to)\s*\d+\s*days?\b|\b(?:within|up to)\s*\d+\s*days?\b[^.!?]{0,100}\b(?:return(?:s|ed)?|refund(?:s|ed)?)\b/i,
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
    const conflict = [...retained.product, ...retained.policy].some(item =>
      patterns[kind][field].test(item === missing ? item.excerpt.replace(missingTerms[kind], '') : item.excerpt));
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

// Score only retained observations: an incomplete or ambiguous policy is not
// evidence that a term is absent. `policies` can supply linked observations
// separately from the snapshot, without fetching anything during scoring.
export function scorePreparedPolicies(snapshot, derived, policies = {}) {
  const observed = { ...snapshot, policies: { ...snapshot?.policies, ...policies } };
  const result = {};
  for (const [kind, id] of [['shipping', 'C3.shipping'], ['returns', 'C3.returns']]) {
    const retained = retainedSources(observed, derived, kind);
    const sources = [...retained.product, ...retained.policy].filter(ref => supported(ref) && sameOrigin(ref.url, observed.url));
    const conflict = [...retained.product, ...retained.policy].some(ref =>
      (contextual.test(ref.excerpt) && new RegExp(kind === 'shipping' ? '\\b(?:shipping|delivery)\\b' : '\\b(?:return|refund)', 'i').test(ref.excerpt)) || missingTerms[kind].test(ref.excerpt) ||
      /\b(?:shipping|delivery|returns?|refunds?)\s+(?:is|are)\s+(?:not available|unavailable|not accepted)\b/i.test(ref.excerpt));
    // A bare number of days may describe warranty, dispatch, or another offer.
    const relevant = ref => kind === 'shipping'
      ? /\b(?:ship(?:ping|s)?|deliver(?:y|ed|s)?|arriv(?:al|es?))\b/i.test(ref.excerpt)
      : /\b(?:return(?:s|ed)?|refund(?:s|ed)?)\b/i.test(ref.excerpt);
    const scoped = sources.some(ref => relevant(ref) && productScope.test(ref.excerpt));
    const evidence = scoped && !conflict ? sources.filter(relevant) : [];
    const terms = patterns[kind].map(re => ({ evidence: evidence.filter(ref => re.test(ref.excerpt)) }));
    const negativeReturns = /\b(?:cannot|can't|not|never)\b[^.!?;]{0,45}\b(?:return(?:s|ed)?|refund(?:s|ed)?)\b|\b(?:return(?:s|ed)?|refund(?:s|ed)?)\b[^.!?;]{0,45}\b(?:not|never|unavailable|prohibited)\b|\bno (?:returns?|refunds?)\b/i;
    const negativeShipping = /\b(?:does not|do not|doesn't|don't|cannot|can't|will not|won't|unable to|not|never|no)\s+(?:(?:be|currently|yet)\s+)?(?:ship\w*|deliver\w*)\b|\b(?:shipping|delivery)\s+(?:is\s+)?(?:not available|unavailable|not offered)\b/i;
    const clauses = sources.flatMap(ref => ref.excerpt.split(/[.!?;](?:\s+|$)|\s+\b(?:but|however)\b\s*[:,]?\s*/i));
    const hasFinalSale = kind === 'returns' && clauses.some(clause => finalSale.test(clause));
    const finalConflict = hasFinalSale && clauses.some(clause => !negativeReturns.test(clause) &&
      /\b(?:return(?:s|ed)?|refund(?:s|ed)?)\b[^.!?;]{0,60}\b(?:accepted|eligible|within)\b/i.test(clause.replace(finalSale, '')));
    const negativeReturnTerms = kind === 'returns' && !hasFinalSale && clauses.some(clause => negativeReturns.test(clause));
    const pickupConflict = kind === 'shipping' && clauses.some(clause => pickupOnly.test(clause)) &&
      clauses.some(clause => !negativeShipping.test(clause) && /\b(?:ships?|delivers?)\s+(?:to|within)\b|\bfree shipping\b/i.test(clause));
    const negativeShippingTerms = kind === 'shipping' && clauses.some(clause => negativeShipping.test(clause));
    const policyFinding = assessBinaryPolicy(kind, { status: 'measured', fraction: 1, policyTerms: terms },
      { snapshot: observed, extracted: derived });
    result[id] = !retained.productComplete ? unknown('The product evidence was incomplete.') :
      finalConflict ? unknown('Conflicting return terms were found.') :
      negativeReturnTerms ? unknown('The return terms contain a restriction that could not be resolved.') :
      pickupConflict ? unknown('Pickup-only and shipping terms conflict.') :
      negativeShippingTerms && policyFinding.status === 'measured' && policyFinding.fraction === 1
        ? unknown('The shipping terms contain a restriction that could not be resolved.') : policyFinding;
    if (result[id].status === 'not_measured') {
      const partial = sources.filter(relevant);
      const names = kind === 'shipping' ? ['shipping coverage', 'shipping cost', 'delivery timing'] :
        ['return eligibility', 'return window', 'return conditions'];
      const unresolved = names.filter((_, i) => !partial.some(ref => patterns[kind][i].test(ref.excerpt)));
      const details = [];
      if (!scoped) details.push('product applicability');
      details.push(...unresolved);
      const reason = details.length ? `${result[id].reason} Not established: ${details.join(', ')}.` : result[id].reason;
      const refs = [...new Map(partial.map(ref => [`${ref.url}\n${ref.location}\n${ref.excerpt}`, ref])).values()].slice(0, 3);
      result[id] = { ...result[id], reason, ...(refs.length ? { evidence: refs } : {}) };
    }
  }
  return result;
}
