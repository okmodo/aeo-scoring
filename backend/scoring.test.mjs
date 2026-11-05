import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAudit } from './scoring.mjs';

const snapshot = { url: 'https://shop.example/item', status: 200, robots: 'allowed', observedAt: '2026-01-01T00:00:00Z' };
const extracted = () => ({ jsonLd: ['{"@type":"Product","name":"Example shoe"}'], coverage: { html: true, bodyText: false, jsonLdTruncated: false } });

test('records a bounded, ambiguous Product observation without claiming a final score', () => {
  const result = scoreAudit(snapshot, extracted(), { category: 'running-shoes' });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.score, null);
  const entity = result.criteria.find(c => c.id === 'S2').subchecks.find(s => s.id === 'S2.entity');
  assert.deepEqual({ status: entity.status, fraction: entity.fraction, points: entity.points, evidenceIds: entity.evidenceIds },
    { status: 'measured', fraction: 0.5, points: 1, evidenceIds: ['e1'] });
  assert.match(result.evidence[0].location, /application\/ld\+json/);
  assert.equal(result.fixes[0].recoverablePoints, null);
  assert.equal(result.coverage.measured, 1);
  assert.equal(result.coverage.notMeasured, result.coverage.total - 1);
});

test('failed retrieval, invalid JSON, and unrelated or nested products remain unmeasured', () => {
  for (const input of [null, { jsonLd: [] }, { jsonLd: ['broken'] },
    { jsonLd: ['{"@type":"ProductGroup","hasVariant":{"@type":"Product"}}'] },
    { jsonLd: ['{"@type":"Organization"}'] }]) {
    const result = scoreAudit(snapshot, input);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.score, null);
    assert.equal(result.coverage.measured, 0);
    assert.deepEqual(result.evidence, []);
    assert.deepEqual(result.fixes, []);
  }
});

test('missing observations do not become deductions even when extraction succeeded', () => {
  const result = scoreAudit(snapshot, extracted(), { category: 'unknown' });
  assert.equal(result.category, null);
  assert.equal(result.criteria.find(c => c.id === 'S2').subchecks.find(s => s.id === 'S2.offer').status, 'not_measured');
  assert.equal(result.score, null);
});


test('scores associated schema.org Product core properties in equal thirds', () => {
  const record = { '@context': 'https://schema.org', '@type': 'Product', url: snapshot.url,
    name: 'Example shoe', description: 'A running shoe for everyday training.', image: 'https://example.test/shoe.jpg' };
  const run = obj => scoreAudit(snapshot, { jsonLd: [JSON.stringify(obj)], coverage: { jsonLdTruncated: false } });
  const core = result => result.criteria.find(c => c.id === 'S2').subchecks.find(s => s.id === 'S2.core-properties');
  const full = run(record);
  assert.equal(core(full).fraction, 1);
  assert.equal(full.evidence[1].observedAt, snapshot.observedAt);
  assert.equal(full.evidence[1].kind, 'derived_observation');
  const { description, image, ...one } = record;
  const partial = run(one);
  assert.equal(core(partial).fraction, 1 / 3);
  assert.match(partial.evidence[1].excerpt, /absent from record: description, image/);
  assert.equal(core(run({ ...one, description })).fraction, 2 / 3);
  assert.equal(core(run({ '@context': 'https://schema.org', '@type': 'Product', url: snapshot.url })).fraction, 0);
  assert.equal(partial.fixes[0].owner, 'Web developer');
});

test('ambiguous, malformed, externally identified and truncated data do not establish missing properties', () => {
  for (const jsonLd of [
    ['{"@type":"Product","name":"A"}', '{"@type":"Product","name":"B"}'],
    ['{"@type":"Product","name":"A"}', 'bad'],
    ['{"@type":"Product","@id":"https://example.test/p","name":"A"}'],
    ['{"@type":"Product","name":"A","description":{}}'],
    ['{"@type":"Product","name":"A"}' + ' '.repeat(8192)]
  ]) {
    const result = scoreAudit(snapshot, { jsonLd, coverage: { jsonLdTruncated: false } });
    const core = result.criteria.find(c => c.id === 'S2').subchecks.find(s => s.id === 'S2.core-properties');
    assert.equal(core.status, 'not_measured');
    assert.equal(result.score, null);
  }
});


test('withholds property scoring when extraction does not confirm all JSON-LD was retained', () => {
  for (const coverage of [{ jsonLdTruncated: true }, {}]) {
    const result = scoreAudit(snapshot, { ...extracted(), coverage });
    const subchecks = result.criteria.find(c => c.id === 'S2').subchecks;
    assert.equal(subchecks.find(s => s.id === 'S2.entity').status, 'measured');
    assert.equal(subchecks.find(s => s.id === 'S2.core-properties').status, 'not_measured');
    assert.equal(result.score, null);
  }
});


test('unassociated, variant and non-meaningful properties stay unmeasured', () => {
  const base = { '@context': 'https://schema.org', '@type': 'Product', url: snapshot.url, name: 'Example shoe', description: 'A running shoe for everyday training.', image: 'https://example.test/shoe.jpg' };
  for (const record of [{ ...base, url: 'https://shop.example/other' }, { ...base, '@context': 'https://other.test' },
    { ...base, hasVariant: [] }, { ...base, name: 'x' }, { ...base, image: 'javascript:alert(1)' }]) {
    const result = scoreAudit(snapshot, { jsonLd: [JSON.stringify(record)], coverage: { jsonLdTruncated: false } });
    assert.equal(result.criteria.find(c => c.id === 'S2').subchecks.find(s => s.id === 'S2.core-properties').status, 'not_measured');
  }
});
