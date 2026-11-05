import test from 'node:test';
import assert from 'node:assert/strict';
import { compareLabeledSnapshot, snapshotHash, summarizeCounts } from '../scripts/phase2-calibration.mjs';

const snapshot = { html: '<h1>Pack</h1><span itemprop="price">49</span>', url: 'https://example.com/product', method: 'raw', observedAt: '2026-11-05T00:00:00Z' };
const gold = { sha256: snapshotHash(snapshot.html), url: snapshot.url, method: snapshot.method, exhaustiveWithinScope: true, fields: [
  { field: 'name', value: 'Pack', origin: 'visible-html', startOffset: 0, endOffset: 13 },
  { field: 'currency', value: 'USD', origin: 'visible-html', startOffset: 13, endOffset: 45 }
] };

test('comparison counts matches, unmatched outputs and independently supplied missed fields', () => {
  const result = compareLabeledSnapshot(snapshot, gold);
  assert.deepEqual(result.counts, { truePositive: 1, falsePositive: 1, falseNegative: 1 });
  assert.equal(result.matches[0].observation.location.startOffset, 0);
  assert.deepEqual(summarizeCounts([result]), { truePositive: 1, falsePositive: 1, falseNegative: 1, precision: 0.5, recall: 0.5 });
});
test('labels must match exact bytes and source method', () => {
  assert.throws(() => compareLabeledSnapshot({ ...snapshot, html: snapshot.html + ' ' }, gold), /exact snapshot/);
  assert.throws(() => compareLabeledSnapshot({ ...snapshot, method: 'rendered' }, gold), /exact snapshot/);
  assert.throws(() => compareLabeledSnapshot({ ...snapshot, url: 'https://other.example/' }, gold), /exact snapshot/);
});
test('truncated input is excluded instead of silently counted as absence', () => {
  const html = '<p>x</p>'.repeat(101);
  const result = compareLabeledSnapshot({ ...snapshot, html }, { ...gold, sha256: snapshotHash(html) });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.counts, null);
  assert.throws(() => summarizeCounts([result]), /incomplete/);
});
test('empty denominators are unknown and duplicate labels cannot share a match', () => {
  assert.deepEqual(summarizeCounts([]), { truePositive: 0, falsePositive: 0, falseNegative: 0, precision: null, recall: null });
  const one = { ...gold, fields: [gold.fields[0], gold.fields[0]] };
  assert.equal(compareLabeledSnapshot(snapshot, one).counts.falseNegative, 1);
});
