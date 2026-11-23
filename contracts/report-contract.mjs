import rubric1 from '../config/rubric.v1.json' with { type: 'json' };
import rubric2 from '../config/rubric.v2.json' with { type: 'json' };
import copy1 from './catalog.v1.json' with { type: 'json' };
import copy2 from './catalog.v2.json' with { type: 'json' };
import copy3 from './catalog.v3.json' with { type: 'json' };


export const SUPPORTED_RUBRIC_VERSIONS = Object.freeze(['1.0.0', '2.0.0', '3.0.0']);
const catalogs = new Map([[rubric1.version, [rubric1, copy1]], [rubric2.version, [rubric2, copy2]]]);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const close = (a, b) => Math.abs(a - b) < 1e-6;

export function getTestCopy(version, id) {
  if (version === '3.0.0') return Object.hasOwn(copy3, id) && v3FullCredit(id) ? { ...copy3[id], fullCredit: v3FullCredit(id) } : null;
  const entry = catalogs.get(version);
  if (!entry || !Object.hasOwn(entry[1], id)) return null;
  const check = entry[0].criteria.flatMap(c => c.subchecks).find(c => c.id === id);
  return check ? { ...entry[1][id], fullCredit: check.full } : null;
}

// Derive the engine's effective weight, including redistribution after exclusions.
export function availablePointsForCheck(report, id) {
  if (report?.rubricVersion === '3.0.0') return v3AvailablePoints(report, id);
  const rubric = catalogs.get(report?.rubricVersion)?.[0];
  const criterionDef = rubric?.criteria.find(c => c.subchecks.some(s => s.id === id));
  const def = criterionDef?.subchecks.find(s => s.id === id);
  const criterion = Array.isArray(report?.criteria) ? report.criteria.find(c => c?.id === criterionDef?.id) : null;
  if (!def || !criterion || !Array.isArray(criterion.subchecks)) return null;
  const check = criterion.subchecks.find(s => s?.id === id);
  if (!check) return null;
  if (check.status === 'not_applicable') return 0;
  const completeSet = criterion.subchecks.length === criterionDef.subchecks.length &&
    criterionDef.subchecks.every(s => criterion.subchecks.some(c => c?.id === s.id));
  if (!completeSet || criterion.subchecks.some(c => c?.status === 'not_measured')) return def.maxPoints;
  const denominator = criterionDef.subchecks.reduce((total, s) =>
    total + (criterion.subchecks.find(c => c?.id === s.id)?.status === 'not_applicable' ? 0 : s.maxPoints), 0);
  return denominator > 0 ? def.maxPoints * criterionDef.maxPoints / denominator : def.maxPoints;
}

// Validate untrusted wire data without placing merchant content in diagnostics.
export function validateReport(report) {
  if (report?.rubricVersion === '3.0.0') return validateV3Report(report);
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { valid: false, errors: ['Invalid report'] };
  const entry = catalogs.get(report.rubricVersion);
  if (!entry) return { valid: false, errors: ['Unsupported rubric version'] };
  if (report.contractVersion !== undefined && report.contractVersion !== '1.0.0') errors.push('Unsupported report contract version');
  if (!['complete', 'incomplete'].includes(report.status)) errors.push('Invalid report status');
  for (const key of ['productName', 'category', 'variant', 'market', 'currency']) {
    if (!(report[key] === null || typeof report[key] === 'string')) errors.push('Invalid report context');
  }
  if (!Array.isArray(report.criteria) || !Array.isArray(report.evidence) || !Array.isArray(report.fixes)) return { valid: false, errors: [...errors, 'Invalid report collections'] };
  const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
  if (!report.coverage || typeof report.coverage !== 'object' || !strings(report.coverage.limitations)) errors.push('Invalid coverage');
  if (report.evidence.some(e => !e || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.excerpt !== 'string' || typeof e.method !== 'string' || typeof e.kind !== 'string' || typeof e.url !== 'string' || typeof e.location !== 'string' || typeof e.observedAt !== 'string')) errors.push('Invalid evidence');
  if (report.fixes.some(f => !f || typeof f !== 'object' || typeof f.id !== 'string' || typeof f.title !== 'string' || typeof f.owner !== 'string' || typeof f.condition !== 'string' || !strings(f.checkIds) || !strings(f.evidenceIds) || !(f.recoverablePoints === null || finite(f.recoverablePoints)))) errors.push('Invalid fixes');
  const definitions = new Map(entry[0].criteria.flatMap(c => c.subchecks.map(s => [s.id, { ...s, criterion: c.id, pillar: c.pillar }])));
  const seen = new Set(); let unmeasured = false; let sum = 0; const pillars = { structure: 0, content: 0 };
  for (const criterion of report.criteria) {
    if (!criterion || !Array.isArray(criterion.subchecks)) { errors.push('Invalid criterion'); continue; }
    for (const check of criterion.subchecks) {
      const def = check && definitions.get(check.id);
      if (!def || def.criterion !== criterion.id || criterion.pillar !== def.pillar) { errors.push('Unknown or misplaced check'); continue; }
      if (seen.has(check.id)) errors.push('Duplicate check');
      seen.add(check.id);
      if (!finite(check.maxPoints) || !close(check.maxPoints, def.maxPoints)) errors.push('Invalid maximum points');
      const expected = availablePointsForCheck(report, check.id);
      const available = check.availablePoints ?? expected;
      if (!finite(available) || available < 0 || available > 100) errors.push('Invalid available points');
      if (check.availablePoints !== undefined && (!finite(expected) || !close(available, expected))) errors.push('Invalid redistributed points');
      if (check.presentation !== undefined) {
        const presentation = check.presentation;
        const keys = ['name', 'description', 'improve', 'fullCredit'];
        if (report.contractVersion !== '1.0.0' || !presentation || typeof presentation !== 'object' || Array.isArray(presentation) ||
            Object.keys(presentation).length !== keys.length || keys.some(key => !Object.hasOwn(presentation, key) || typeof presentation[key] !== 'string' || presentation[key].trim().length === 0 || presentation[key].length > 2000)) errors.push('Invalid check presentation');
      }
      if (!(check.reason === null || typeof check.reason === 'string') || !(check.exclusion === undefined || check.exclusion === null || typeof check.exclusion === 'string')) errors.push('Invalid check explanation');
      if (!Array.isArray(check.evidenceIds) || !check.evidenceIds.every(id => typeof id === 'string')) errors.push('Invalid evidence references');
      if (check.status === 'measured') {
        if (!finite(check.fraction) || check.fraction < 0 || check.fraction > 1 || !finite(check.points) || check.points < 0 || !finite(available) || check.points > available + 1e-6 || !close(check.points, check.fraction * available)) errors.push('Invalid measured points');
        else { sum += check.points; pillars[def.pillar] += check.points; }
      } else if (check.status === 'not_measured' || check.status === 'not_applicable') {
        if (check.status === 'not_measured') unmeasured = true;
        if (check.fraction !== null || check.points !== null || (check.status === 'not_applicable' && check.availablePoints !== undefined && check.availablePoints !== 0)) errors.push('Invalid unscored check');
      } else errors.push('Invalid check status');
    }
  }
  if (report.status === 'complete') {
    const s = report.score;
    if (seen.size !== definitions.size || unmeasured || !s || !finite(s.total) || !finite(s.structure) || !finite(s.content) || s.total < 0 || s.total > 100 || !close(s.total, s.structure + s.content) || !close(s.total, sum) || !close(s.structure, pillars.structure) || !close(s.content, pillars.content)) errors.push('Invalid complete score');
  } else if (report.score !== null) errors.push('Incomplete report has a score');
  return { valid: errors.length === 0, errors };
}

export function serializeReport(report) {
  const result = validateReport(report);
  if (!result.valid) throw new TypeError(`Invalid report: ${result.errors.join('; ')}`);
  if (report.rubricVersion === '3.0.0') return { ...report, contractVersion: '1.0.0' };
  return { ...report, contractVersion: '1.0.0', criteria: report.criteria.map(c => ({ ...c, subchecks: c.subchecks.map(s => ({ ...s, presentation: getTestCopy(report.rubricVersion, s.id) })) })) };
}

// Presentation groups combine components without changing their scoring criteria.
export const RUBRIC_V3_GROUPS = [
  { id:'S1', pillar:'structure', rows:[
    ['S1.readable-html','S1.delivery','S1.readability'], ['S1.scope','S1.scope'],
    ['S1.configuration','S1.configuration'], ['S1.supporting-access','S1.supporting-access'],
  ]},
  { id:'S2', pillar:'structure', rows:[
    ['S2.product-markup','S2.json-ld','S2.syntax'], ['S2.product-identity','S2.entity','S2.variants','S3.identity'],
    ['S2.offer-agreement','S2.offer','S3.price','S3.availability'], ['S2.identifiers','S2.identifiers'],
    ['S2.optional-claims','S3.optional-claims'],
  ]},
  { id:'S4', pillar:'structure', rows:[['S4.page-labels','S4.title','S4.organization'],['S4.image-alternatives','S4.image-alternatives']]},
  { id:'S5', pillar:'structure', rows:[['S5.crawler-access','S5.search','S5.ai-retrieval'],['S5.sitemap','S6.usable','S6.inclusion'],['S5.llms-txt','S7.identity','S7.links']]},
  { id:'C1', pillar:'content', rows:[
    ['C1.identity-explanation','C1.identity','C1.explanation'], ['C1.options-selection','C1.configuration','C4.selection'],
    ['C1.essential-specs','C2.essential'], ['C1.supporting-details','C2.supporting','C4.limitations'],
    ['C1.use-compatibility','C4.intended-use','C4.compatibility'],
  ]},
  { id:'C3', pillar:'content', rows:[['C3.price-stock','C3.price','C3.availability'],['C3.shipping','C3.shipping'],['C3.returns','C3.returns']]},
  { id:'C5', pillar:'content', rows:[['C5.consistency','C5.consistency'],['C5.claim-support','C5.claim-support']]},
];




// Scoring boundaries stay at the original criterion even when a row joins sources.
const sourceCriteria = rubric2.criteria.filter(c => c.id !== 'S8').concat([{ id: 'S2-json-ld', pillar: 'structure', maxPoints: 1, subchecks: [{ id: 'S2.json-ld', maxPoints: 1, full: 'On-page initial or rendered HTML contains parseable Schema.org Product or ProductGroup JSON-LD.' }] }]);
const sourceDefinitions = new Map(sourceCriteria.flatMap(c => c.subchecks.map(s => [s.id, { ...s, criterion: c.id }])));
const rowDefinitions = new Map(RUBRIC_V3_GROUPS.flatMap(g => g.rows.map(([id, ...components]) => [id, { group: g.id, pillar: g.pillar, components }])));
const v3Finite = n => typeof n === 'number' && Number.isFinite(n);
const v3Close = (a, b) => v3Finite(a) && v3Finite(b) && Math.abs(a - b) < 1e-6;
const v3Strings = a => Array.isArray(a) && a.every(x => typeof x === 'string');
const sum = a => a.reduce((x, y) => x + y, 0);
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && a.every(x => b.includes(x));

export function v3FullCredit(id) {
  const row = rowDefinitions.get(id);
  return row ? row.components.map(component => sourceDefinitions.get(component).full).join(' ') : null;
}

// Only return wire values after validating the entire report.
export function v3AvailablePoints(report, id) {
  if (!validateV3Report(report).valid) return null;
  return report.criteria.flatMap(c => c.subchecks).find(c => c.id === id)?.availablePoints ?? null;
}

export function validateV3Report(report) {
  const errors = [];
  const bad = message => { if (!errors.includes(message)) errors.push(message); };
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { valid: false, errors: ['Invalid report'] };
  if (report.rubricVersion !== '3.0.0') return { valid: false, errors: ['Unsupported rubric version'] };
  if (report.contractVersion !== undefined && report.contractVersion !== '1.0.0') bad('Unsupported report contract version');
  if (!['complete', 'incomplete'].includes(report.status)) bad('Invalid report status');
  for (const key of ['productName', 'category', 'variant', 'market', 'currency']) if (!(report[key] === null || typeof report[key] === 'string')) bad('Invalid report context');
  if (!Array.isArray(report.criteria) || !Array.isArray(report.evidence) || !Array.isArray(report.fixes)) return { valid: false, errors: [...errors, 'Invalid report collections'] };
  if (!report.coverage || typeof report.coverage !== 'object' || !v3Strings(report.coverage.limitations)) bad('Invalid coverage');
  if (report.evidence.some(e => !e || typeof e !== 'object' || ['id', 'excerpt', 'method', 'kind', 'url', 'location', 'observedAt'].some(k => typeof e[k] !== 'string'))) bad('Invalid evidence');
  if (report.fixes.some(f => !f || typeof f !== 'object' || ['id', 'title', 'owner', 'condition'].some(k => typeof f[k] !== 'string') || !v3Strings(f.checkIds) || !v3Strings(f.evidenceIds) || !(f.recoverablePoints === null || (v3Finite(f.recoverablePoints) && f.recoverablePoints >= 0)))) bad('Invalid fixes');
  const seenGroups = new Set(), seenRows = new Set(), sources = new Map();
  let total = 0; const pillars = { structure: 0, content: 0 };
  for (const group of report.criteria) {
    const def = RUBRIC_V3_GROUPS.find(g => g.id === group?.id);
    if (!def || seenGroups.has(group.id) || group.pillar !== def.pillar || !Array.isArray(group.subchecks)) { bad('Invalid group'); continue; }
    seenGroups.add(group.id);
    if (!sameSet(group.subchecks.map(c => c?.id), def.rows.map(r => r[0]))) bad('Invalid group rows');
    let groupMax = 0, groupPoints = 0;
    for (const row of group.subchecks) {
      const rd = rowDefinitions.get(row?.id);
      if (!rd || rd.group !== group.id || seenRows.has(row.id) || !Array.isArray(row.components)) { bad('Invalid row'); continue; }
      seenRows.add(row.id);
      if (!sameSet(row.components.map(c => c?.id), rd.components)) bad('Invalid row components');
      let rowMax = 0, available = 0, earned = 0;
      for (const component of row.components) {
        const cd = sourceDefinitions.get(component?.id);
        if (!cd || !rd.components.includes(component.id) || sources.has(component.id)) { bad('Invalid component'); continue; }
        sources.set(component.id, component);
        if (!v3Close(component.maxPoints, cd.maxPoints) || !v3Finite(component.availablePoints) || component.availablePoints < 0 || component.availablePoints > 100) bad('Invalid component points');
        if (!(component.reason === null || typeof component.reason === 'string') || !(component.exclusion === undefined || component.exclusion === null || typeof component.exclusion === 'string') || !v3Strings(component.evidenceIds)) bad('Invalid component details');
        if (component.status === 'measured') {
          if (!v3Finite(component.fraction) || component.fraction < 0 || component.fraction > 1 || !v3Finite(component.points) || component.points < 0 || !v3Close(component.points, component.fraction * component.availablePoints)) bad('Invalid measured points');
        } else if (component.status === 'not_measured' || component.status === 'not_applicable') {
          if (component.points !== null || component.fraction !== null || (component.status === 'not_applicable' && component.availablePoints !== 0)) bad('Invalid unscored component');
        } else bad('Invalid component status');
        rowMax += component.maxPoints; available += component.availablePoints; earned += component.points ?? 0;
      }
      const status = row.components.every(c => c?.status === 'not_applicable') ? 'not_applicable' : row.components.some(c => c?.status === 'not_measured') ? 'not_measured' : 'measured';
      if (!v3Close(row.maxPoints, rowMax) || !v3Close(row.availablePoints, available) || !v3Close(row.earnedPoints, earned) || row.status !== status || !v3Strings(row.evidenceIds) || !(row.reason === null || typeof row.reason === 'string')) bad('Invalid row totals');
      if (!Array.isArray(row.evidenceIds) || !sameSet(row.evidenceIds, [...new Set(row.components.flatMap(c => Array.isArray(c?.evidenceIds) ? c.evidenceIds : []))])) bad('Invalid row evidence references');
      if (status === 'measured' ? (!v3Close(row.points, earned) || !v3Close(row.fraction, earned / available)) : (row.points !== null || row.fraction !== null)) bad('Invalid row score');
      groupMax += rowMax; groupPoints += earned;
    }
    if (!v3Close(group.maxPoints, groupMax) || !v3Close(group.points, groupPoints) || typeof group.complete !== 'boolean') bad('Invalid group totals');
    total += groupPoints; pillars[group.pillar] += groupPoints;
  }
  if (seenGroups.size !== RUBRIC_V3_GROUPS.length || seenRows.size !== rowDefinitions.size || sources.size !== sourceDefinitions.size) bad('Missing report checks');
  for (const criterion of sourceCriteria) {
    const components = criterion.subchecks.map(s => sources.get(s.id));
    if (components.some(c => !c)) continue;
    const unresolved = components.some(c => c.status === 'not_measured');
    const denominator = sum(criterion.subchecks.map((s, i) => components[i].status === 'not_applicable' ? 0 : s.maxPoints));
    for (const [i, c] of components.entries()) {
      const expected = c.status === 'not_applicable' ? 0 : unresolved || denominator === 0 ? criterion.subchecks[i].maxPoints : criterion.subchecks[i].maxPoints * criterion.maxPoints / denominator;
      if (!v3Close(c.availablePoints, expected)) bad('Invalid redistributed points');
    }
  }
  for (const group of report.criteria) {
    const def = RUBRIC_V3_GROUPS.find(g => g.id === group?.id);
    if (!def || !Array.isArray(group.subchecks)) continue;
    const complete = def.rows.flatMap(r => r.slice(1)).every(id => {
      const component = sources.get(id), criterion = sourceCriteria.find(c => c.id === sourceDefinitions.get(id)?.criterion);
      return component && criterion && criterion.subchecks.every(s => sources.get(s.id)?.status !== 'not_measured') && criterion.subchecks.some(s => sources.get(s.id)?.status !== 'not_applicable');
    });
    if (group.complete !== complete) bad('Invalid group completion');
  }
  if (!v3Close(report.earnedPoints, total)) bad('Invalid earned points');
  if (report.status === 'complete') {
    const s = report.score;
    if (report.criteria.some(c => !c?.complete) || !s || !v3Close(s.total, total) || !v3Close(s.structure, pillars.structure) || !v3Close(s.content, pillars.content) || !v3Close(s.total, s.structure + s.content) || s.total < 0 || s.total > 100) bad('Invalid complete score');
  } else if (report.score !== null) bad('Invalid incomplete score');
  return { valid: errors.length === 0, errors };
}
