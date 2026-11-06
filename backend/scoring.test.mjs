import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAudit } from './scoring.mjs';

const snapshot = { url: 'https://shop.example/item', status: 200, robots: 'allowed', observedAt: '2026-01-01T00:00:00Z' };
const extracted = () => ({ jsonLd: ['{"@context":"https://schema.org","@type":"Product","name":"Example shoe"}'], coverage: { html: true, bodyText: false, jsonLdTruncated: false } });

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
    { jsonLd: ['{"@type":"ProductGroup","hasVariant":{"@context":"https://schema.org","@type":"Product"}}'] },
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
  assert.equal(partial.fixes[0].recoverablePoints, 2 - core(partial).points);
  assert.deepEqual(partial.fixes[0].checkIds, ['S2.core-properties']);
});

test('ambiguous, malformed, externally identified and truncated data do not establish missing properties', () => {
  for (const jsonLd of [
    ['{"@context":"https://schema.org","@type":"Product","name":"A"}', '{"@context":"https://schema.org","@type":"Product","name":"B"}'],
    ['{"@context":"https://schema.org","@type":"Product","name":"A"}', 'bad'],
    ['{"@context":"https://schema.org","@type":"Product","@id":"https://example.test/p","name":"A"}'],
    ['{"@context":"https://schema.org","@type":"Product","name":"A","description":{}}'],
    ['{"@context":"https://schema.org","@type":"Product","name":"A"}' + ' '.repeat(8192)]
  ]) {
    const result = scoreAudit(snapshot, { jsonLd, coverage: { jsonLdTruncated: false } });
    const core = result.criteria.find(c => c.id === 'S2').subchecks.find(s => s.id === 'S2.core-properties');
    assert.equal(core.status, 'not_measured');
    assert.equal(result.score, null);
  }
});


test('withholds property scoring when extraction does not confirm all JSON-LD was retained', () => {
  const jsonLd = [JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Product', url: snapshot.url,
    name: 'Example shoe', description: 'A running shoe for everyday training.',
    image: 'https://shop.example/shoe.png',
  })];
  const control = scoreAudit(snapshot, { jsonLd, coverage: { jsonLdTruncated: false } });
  assert.equal(control.criteria.find(c => c.id === 'S2').subchecks[1].fraction, 1);
  for (const coverage of [{ jsonLdTruncated: true }, {}]) {
    const result = scoreAudit(snapshot, { jsonLd, coverage });
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

test('unqualified and unrelated vocabularies do not establish a schema.org Product', () => {
  for (const record of [{ '@type': 'Product' }, { '@type': 'Product', '@context': 'https://example.com/vocabulary' }]) {
    const result = scoreAudit(snapshot, { jsonLd: [JSON.stringify(record)], coverage: { jsonLdTruncated: false } });
    assert.equal(result.criteria.find(c => c.id === 'S2').subchecks[0].status, 'not_measured');
    assert.deepEqual(result.evidence, []);
  }
});

import './product-fields.test.mjs';

test('associated raw Product offers and identifiers contribute evidence without a final score', () => {
  const product = {
    '@context': 'https://schema.org', '@type': 'Product', name: 'Example shoe', url: snapshot.url,
    offers: { '@type': 'Offer', price: '49.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
    brand: { '@type': 'Brand', name: 'Example' }, sku: 'EX-1',
  };
  const run = (record, coverage = { jsonLdTruncated: false }) =>
    scoreAudit(snapshot, { jsonLd: [JSON.stringify(record)], coverage });
  const check = (report, id) => report.criteria.flatMap(c => c.subchecks).find(s => s.id === id);
  const report = run(product);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.score, null);
  assert.equal(report.currency, 'USD');
  assert.equal(check(report, 'S2.offer').points, 2);
  assert.equal(check(report, 'S2.identifiers').points, 1.5);
  const fix = report.fixes.find(item => item.checkIds.includes('S2.identifiers'));
  assert.equal(fix.recoverablePoints, 0.5);
  assert.ok(report.evidence.some(item => item.id === fix.evidenceIds[0] && item.kind === 'derived_observation'));
  assert.equal(check(run({ ...product, url: 'https://other.example/item' }), 'S2.offer').status, 'not_measured');
  assert.equal(check(run(product, { jsonLdTruncated: true }), 'S2.identifiers').status, 'not_measured');
});

test('crawler policy grades verified pools independently and keeps unresolved pools unmeasured', () => {
  const url = 'https://shop.example/robots.txt';
  const observations = [
    { botId: 'googlebot', status: 'allowed' }, { botId: 'bingbot', status: 'disallowed' },
    { botId: 'oai-searchbot', status: 'allowed' }, { botId: 'claude-searchbot', status: 'allowed' },
    { botId: 'perplexitybot', status: 'disallowed' }, { botId: 'gptbot', status: 'allowed' },
  ];
  const run = (entries, version = '1.0.0') =>
    scoreAudit({ ...snapshot, crawlerPolicy: { url, version, httpStatus: 200, observations: entries } }, null);
  const report = run(observations);
  const [search, retrieval] = report.criteria.find(c => c.id === 'S5').subchecks;
  assert.equal(search.points, 0.5);
  assert.equal(retrieval.points, 2 / 3);
  assert.equal(report.score, null);
  assert.deepEqual(report.evidence.map(e => e.url), [url, url]);
  assert.equal(report.fixes[0].recoverablePoints, 0.5 + (1 - 2 / 3));
  assert.deepEqual(report.fixes[0].checkIds, ['S5.search', 'S5.ai-retrieval']);
  const unresolved = run([...observations, observations[0]]);
  assert.equal(unresolved.criteria.find(c => c.id === 'S5').subchecks[0].status, 'not_measured');
  assert.equal(unresolved.coverage.measured, 1);
  assert.equal(run(observations, '0.0.0').coverage.measured, 0);
});

import './product-labels.test.mjs';

test('scores raw title and explicit brand and model identity only for the uniquely associated Product', () => {
  const name = 'Example Trail X24P Running Shoe';
  const product = { '@context': 'https://schema.org', '@type': 'Product', url: snapshot.url, name, model: 'X24P', brand: 'Example' };
  const run = (record, labelEvidence, jsonLdTruncated = false) => scoreAudit(snapshot, {
    jsonLd: [JSON.stringify(record)], labelEvidence, coverage: { jsonLdTruncated },
  });
  const check = (report, id) => report.criteria.flatMap(c => c.subchecks).find(s => s.id === id);
  const labels = { title: name, mainH1: name };
  const report = run(product, labels);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.score, null);
  assert.equal(check(report, 'S4.title').fraction, 1);
  assert.equal(check(report, 'C1.identity').fraction, 1);
  for (const id of ['S4.title', 'C1.identity']) {
    const [evidenceId] = check(report, id).evidenceIds;
    const evidence = report.evidence.find(item => item.id === evidenceId);
    assert.equal(evidence.url, snapshot.url);
    assert.equal(evidence.kind, 'derived_observation');
    assert.match(evidence.location, /h1/i);
  }
  assert.equal(check(run({ ...product, url: 'https://other.example/item' }, labels), 'C1.identity').status, 'not_measured');
  assert.equal(check(run(product, labels, true), 'S4.title').status, 'not_measured');
  assert.equal(check(run(product, { title: name, mainH1: 'Another item' }), 'C1.identity').status, 'not_measured');
});
