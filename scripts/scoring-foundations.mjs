// Offline arithmetic over already assessed evidence. This is not an extractor or judge.
export function validateFoundations(rubric, categories, crawlers) {
  const errors = [];
  const requireThat = (condition, message) => { if (!condition) errors.push(message); };
  const weights = {S1:13,S2:9,S3:9,S4:3,S5:2,S6:2,S7:1,S8:1,C1:10,C2:20,C3:10,C4:10,C5:10};
  const subweights = {S1:[2,3,3,3,2],S2:[2,2,2,2,1],S3:[2,3,2,2],S4:[1,1,1],S5:[1,1],S6:[1,1],S7:[.5,.5],S8:[.5,.5],C1:[3,4,3],C2:[14,6],C3:[3,2,3,2],C4:[3,3,2,2],C5:[5,5]};
  const expected = {S1:'identity description specifications price availability',S2:'entity core-properties offer identifiers variants',S3:'identity price availability optional-claims',S4:'title organization image-alternatives',S5:'search ai-retrieval',S6:'usable inclusion',S7:'identity links',S8:'context guidance',C1:'identity explanation configuration',C2:'essential supporting',C3:'price availability shipping returns',C4:'intended-use compatibility limitations selection',C5:'consistency claim-support'};
  requireThat(rubric.version === '1.0.0' && rubric.scale === 100, 'rubric version or scale');
  requireThat(rubric.criteria.length === 13 && new Set(rubric.criteria.map(c => c.id)).size === 13, 'criterion IDs');
  for (const c of rubric.criteria) {
    requireThat(c.maxPoints === weights[c.id] && c.pillar === (c.id.startsWith('S') ? 'structure' : 'content'), `${c.id} weight or pillar`);
    requireThat(c.subchecks.map(s => s.id).join(' ') === expected[c.id]?.split(' ').map(x => `${c.id}.${x}`).join(' '), `${c.id} subcheck IDs`);
    requireThat(c.subchecks.reduce((a,s) => a+s.maxPoints,0) === c.maxPoints && c.subchecks.map(s=>s.maxPoints).join() === subweights[c.id]?.join(), `${c.id} sum or subweights`);
    requireThat(['documented_platform_requirement','supported_best_practice','emerging_practice'].includes(c.basis), `${c.id} basis`);
    for (const s of c.subchecks) requireThat(s.maxPoints > 0 && ['full','partial','zero','applicability'].every(k => typeof s[k] === 'string' && s[k].length > 0) && ['deterministic','semantic','mixed'].includes(s.method) && s.sourceUrls?.length && s.sourceUrls.every(u => { try { return new URL(u).protocol === 'https:'; } catch { return false; } }), `${s.id} anchors`);
  }
  for (const [id, points] of [['structure',40],['content',60]]) requireThat(rubric.pillars.some(p => p.id === id && p.maxPoints === points) && rubric.criteria.filter(c=>c.pillar===id).reduce((a,c)=>a+c.maxPoints,0)===points, `${id} total`);
  for (const k of ['evidence','incomplete','notApplicable','delivery','rounding','claimLimits','context']) requireThat(Boolean(rubric.rules[k]), `rule ${k}`);
  requireThat(new Set(categories.categories.map(c=>c.id)).size === 3 && ['running-shoes','casual-daypacks','basic-tshirts'].every(id=>categories.categories.some(c=>c.id===id)), 'category IDs');
  for (const c of categories.categories) {
    const attrs = [...c.essentialAttributes,...c.supportingAttributes];
    requireThat(c.essentialAttributes.length > 0 && c.supportingAttributes.length > 0 && new Set(attrs.map(a=>a.id)).size === attrs.length, `${c.id} pools`);
    for (const a of attrs) requireThat(['full','partial','zero','applicability'].every(k=>a[k]), `${c.id}.${a.id} anchors`);
    const valid = ['C4.intended-use','C4.compatibility','C4.limitations','C4.selection'];
    requireThat(valid.every(id=>c.decisionSupport.some(q=>q.subcheckId===id)) && new Set(c.decisionSupport.map(q=>q.id)).size === c.decisionSupport.length, `${c.id} question mapping`);
    for (const q of c.decisionSupport) requireThat(valid.includes(q.subcheckId) && ['full','partial','zero','applicability'].every(k=>q[k]) && q.attributeRefs.every(id=>attrs.some(a=>a.id===id)), `${c.id}.${q.id} question`);
  }
  const pools = {'S5.search':['googlebot','bingbot'], 'S5.ai-retrieval':['oai-searchbot','claude-searchbot','perplexitybot']};
  requireThat(new Set(crawlers.bots.map(b=>b.id)).size === crawlers.bots.length, 'crawler IDs');
  for (const [pool,ids] of Object.entries(pools)) requireThat(crawlers.bots.filter(b=>b.scoredIn===pool).map(b=>b.id).sort().join()===ids.sort().join(), `${pool} eligibility`);
  for (const b of crawlers.bots) requireThat((b.purpose==='search' && b.scoredIn==='S5.search') || (b.purpose==='retrieval' && b.scoredIn==='S5.ai-retrieval') || (['training','user_triggered'].includes(b.purpose) && b.scoredIn===null), `${b.id} purpose`);
  return errors;
}

export function deliveryFraction(delivery) {
  const values = {initial:1, rendered:0.5, state_blob:0, interaction:0, absent:0, unmeasured:null};
  if (!Object.hasOwn(values,delivery)) throw new Error('Unknown delivery');
  return values[delivery];
}

// Inputs are explicit per-subcheck fractions; null represents unmeasured.
// NA is accepted only for named criterion rules, with a recorded justification.
export function scoreReference(rubric, categories, input) {
  const category = categories.categories.find(c => c.id === input.category);
  const allowedNA = {'S2.variants':'single_configuration','S3.optional-claims':'no_optional_claims','C5.claim-support':'no_material_claims'};
  const known = new Set(rubric.criteria.flatMap(c=>c.subchecks.map(s=>s.id)));
  for (const id of Object.keys(input.checks)) if (!known.has(id)) throw new Error(`Unknown check ${id}`);
  const results = {}; let earned = 0; let complete = Boolean(category);
  for (const c of rubric.criteria) {
    let raw=0, denominator=0, incomplete=false;
    for (const s of c.subchecks) {
      const entry = input.checks[s.id];
      if (!entry) throw new Error(`Missing check ${s.id}`);
      if (entry.status === 'not_applicable') {
        if (s.id.startsWith('C4.') && entry.rule === 'category_conditions_absent') {
          const questions = category?.decisionSupport.filter(q => q.subcheckId === s.id) ?? [];
          const evidence = entry.conditions;
          if (!questions.length || questions.some(q => q.applicability !== 'conditional' || !q.condition) || !Array.isArray(evidence) || evidence.length !== questions.length || new Set(evidence.map(e => e.questionId)).size !== questions.length || questions.some(q => !evidence.some(e => e.questionId === q.id && e.condition === q.condition && e.status === 'absent' && e.evidence && e.location && e.method))) throw new Error(`Unjustified category exclusion ${s.id}`);
        } else if (allowedNA[s.id] !== entry.rule || !entry.justification) throw new Error(`Unjustified exclusion ${s.id}`);
        continue;
      }
      denominator += s.maxPoints;
      if (entry.status === 'not_measured') { incomplete=true; continue; }
      if (entry.status !== 'measured' || typeof entry.fraction !== 'number' || !Number.isFinite(entry.fraction) || entry.fraction < 0 || entry.fraction > 1) throw new Error(`Invalid check ${s.id}`);
      if (entry.fraction < 1 && !entry.evidence) throw new Error(`Missing deduction evidence ${s.id}`);
      raw += s.maxPoints * entry.fraction;
    }
    if (!denominator || incomplete || (!category && ['C2','C4'].includes(c.id))) complete=false;
    // For incomplete criteria, earned points are unadjusted, avoiding an implied final result.
    const points = !category && ['C2','C4'].includes(c.id) ? 0 : denominator && !incomplete ? raw * c.maxPoints / denominator : raw;
    earned += points;
    results[c.id] = {points, denominator, complete: Boolean(denominator) && !incomplete && (Boolean(category) || !['C2','C4'].includes(c.id))};
  }
  return {status:complete?'complete':'incomplete', finalScore:complete?earned:null, earnedPoints:earned, criteria:results};
}
