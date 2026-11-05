// Offline comparison of frozen snapshot observations to independently supplied labels.
// This reports evidence agreement, not rubric scores or proof that labels are independent.
import { createHash } from 'node:crypto';
import { inspectSnapshot } from './feasibility.mjs';

export function snapshotHash(html) {
  if (typeof html !== 'string') throw new Error('Snapshot must be a string');
  return createHash('sha256').update(html, 'utf8').digest('hex');
}

export function compareLabeledSnapshot(snapshot, gold) {
  if (!snapshot || !gold || snapshotHash(snapshot.html) !== gold.sha256 || snapshot.url !== gold.url || snapshot.method !== gold.method) throw new Error('Labels must match exact snapshot, URL and method');
  if (gold.exhaustiveWithinScope !== true || !Array.isArray(gold.fields) || !gold.fields.every(f => f && ['name', 'description', 'material', 'price', 'currency'].includes(f.field) && typeof f.value === 'string' && f.value.length > 0 && ['visible-html', 'json-ld'].includes(f.origin) && Number.isInteger(f.startOffset) && Number.isInteger(f.endOffset) && f.startOffset >= 0 && f.endOffset > f.startOffset && f.endOffset <= snapshot.html.length)) throw new Error('Exhaustive scoped gold fields with valid source locations required');
  const result = inspectSnapshot(snapshot);
  if (!result.coverage.complete) return { status: 'incomplete', counts: null, observations: result.productFields, reason: 'Truncated extraction cannot be evaluated as complete.' };
  // Treat duplicate identical observations as a multiset; one output cannot satisfy two labels.
  const remaining = gold.fields.map(f => ({ ...f }));
  const matches = [], unmatched = [];
  for (const observation of result.productFields) {
    const index = remaining.findIndex(f => f.field === observation.field && f.value === observation.value && f.origin === observation.origin && JSON.stringify(f.context ?? null) === JSON.stringify(observation.context ?? null) && f.startOffset < observation.location.endOffset && observation.location.startOffset < f.endOffset);
    if (index < 0) unmatched.push(observation);
    else matches.push({ observation, label: remaining.splice(index, 1)[0] });
  }
  return { status: 'measured', counts: { truePositive: matches.length, falsePositive: unmatched.length, falseNegative: remaining.length }, matches, unmatched, missed: remaining, caveat: 'Counts reflect supplied labels within extractor scope; they do not establish label independence, representativeness, or truth.' };
}

export function summarizeCounts(results) {
  if (!Array.isArray(results) || results.some(r => r.status !== 'measured')) throw new Error('All results must be measured; report incomplete cases separately');
  const counts = results.reduce((a, r) => ({ truePositive: a.truePositive + r.counts.truePositive, falsePositive: a.falsePositive + r.counts.falsePositive, falseNegative: a.falseNegative + r.counts.falseNegative }), { truePositive: 0, falsePositive: 0, falseNegative: 0 });
  const { truePositive: tp, falsePositive: fp, falseNegative: fn } = counts;
  return { ...counts, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null };
}
