import rubric1 from '../config/rubric.v1.json' with { type: 'json' };
import rubric2 from '../config/rubric.v2.json' with { type: 'json' };
import copy1 from './catalog.v1.json' with { type: 'json' };
import copy2 from './catalog.v2.json' with { type: 'json' };

export const SUPPORTED_RUBRIC_VERSIONS = Object.freeze(['1.0.0', '2.0.0']);
const catalogs = new Map([[rubric1.version, [rubric1, copy1]], [rubric2.version, [rubric2, copy2]]]);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const close = (a, b) => Math.abs(a - b) < 1e-6;

export function getTestCopy(version, id) {
  const entry = catalogs.get(version);
  if (!entry || !Object.hasOwn(entry[1], id)) return null;
  const check = entry[0].criteria.flatMap(c => c.subchecks).find(c => c.id === id);
  return check ? { ...entry[1][id], fullCredit: check.full } : null;
}

// Derive the engine's effective weight, including redistribution after exclusions.
export function availablePointsForCheck(report, id) {
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
  return { ...report, contractVersion: '1.0.0', criteria: report.criteria.map(c => ({ ...c, subchecks: c.subchecks.map(s => ({ ...s, presentation: getTestCopy(report.rubricVersion, s.id) })) })) };
}
