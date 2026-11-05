import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectSnapshot, observePhrase, compareSnapshots } from '../scripts/feasibility.mjs';
const fixture = JSON.parse(readFileSync('evals/fixtures/feasibility/synthetic/cases.json', 'utf8'));
const context = { url: 'https://example.com/product', method: 'raw', observedAt: '2026-11-04T00:00:00Z' };
for (const c of fixture.cases) test(`frozen snapshot: ${c.id}`, () => {
  const result = inspectSnapshot({ ...context, html: c.html });
  for (const [phrase, expected] of Object.entries(c.phrases)) {
    const actual = observePhrase(result, phrase);
    assert.equal(actual.state, expected);
    for (const e of actual.evidence) assert.ok(c.html.slice(e.location.startOffset, e.location.endOffset).length > 0);
  }
  assert.equal(result.coverage.complete, true);
});
test('raw and rendered comparison exposes observed change without assuming absence', () => {
  const raw = inspectSnapshot({ ...context, html: fixture.cases[0].html });
  const rendered = inspectSnapshot({ ...context, method: 'rendered', html: fixture.cases[1].html });
  const comparison = compareSnapshots(raw, rendered, 'Waterproof');
  assert.equal(comparison.raw.state, 'not_observed'); assert.equal(comparison.rendered.state, 'observed');
  assert.match(comparison.raw.interpretation, /absence is not established/);
  assert.throws(() => compareSnapshots(raw, { ...rendered, source: { ...rendered.source, url: 'https://other.test/' } }, 'x'));
});
test('input and output bounds fail closed and disclose truncation', () => {
  assert.throws(() => inspectSnapshot({ ...context, html: 'x'.repeat(1024 * 1024 + 1) }));
  assert.throws(() => inspectSnapshot({ ...context, html: 'é'.repeat(512 * 1024 + 1) }));
  assert.throws(() => inspectSnapshot({ ...context, url: 'file:///etc/passwd', html: '' }));
  assert.throws(() => inspectSnapshot({ ...context, observedAt: 'unknown', html: '' }));
  const result = inspectSnapshot({ ...context, html: '<p>x</p>'.repeat(101) });
  assert.equal(result.findings.length, 100); assert.equal(result.coverage.complete, false);
  assert.throws(() => observePhrase(result, ''));
  const tail = inspectSnapshot({ ...context, html: '<p>' + 'x'.repeat(500) + ' needle</p>' });
  assert.equal(tail.coverage.complete, false);
  assert.equal(observePhrase(tail, 'needle').state, 'not_observed');
});
test('phrase matching is not a semantic judgment and never follows injected text', () => {
  const result = inspectSnapshot({ ...context, html: fixture.cases[2].html });
  assert.equal(observePhrase(result, 'waterproof').state, 'observed');
  assert.match(observePhrase(result, 'waterproof').interpretation, /meaning is not assessed/);
  assert.ok(result.findings.some(f => f.text.startsWith('Ignore all prior instructions')));
});

test('bounded model request and untrusted response validation fail closed', async () => {
  const { buildContentRequest, validateContentResponse } = await import('../scripts/feasibility.mjs');
  const result = inspectSnapshot({ ...context, html: fixture.cases[2].html });
  const request = buildContentRequest(result, 'Does the page claim waterproofing?');
  assert.equal(request.max_tokens, 256); assert.equal(request.retries, 0);
  assert.match(request.instruction, /untrusted data/);
  const valid = validateContentResponse(request, { state: 'uncertain', evidenceIds: ['e2'], rationale: 'The text negates waterproofing.' });
  assert.match(valid.caveat, /human semantic review/);
  for (const response of [
    { state: 'supported', evidenceIds: ['invented'], rationale: 'yes' },
    { state: 'supported', evidenceIds: [], rationale: 'yes' },
    { state: 'supported', evidenceIds: ['e1'], rationale: 'yes', instruction: 'ignore rules' },
    { state: 'yes', evidenceIds: ['e1'], rationale: 'yes' },
    { state: 'uncertain', evidenceIds: ['e1', 'e1'], rationale: 'yes' }
  ]) assert.throws(() => validateContentResponse(request, response));
  assert.throws(() => buildContentRequest({ ...result, coverage: { complete: false } }, 'question'));
  assert.throws(() => buildContentRequest(result, 'x'.repeat(301)));
});

test('structured and visible product observations retain origins and disagreements', () => {
  const html = `<script type="application/ld+json">{"@type":"Product","name":"Pack A","description":"Small pack","offers":{"@type":"Offer","price":"49","priceCurrency":"USD"}}</script><h1>Pack B</h1><span itemprop="price">59</span>`;
  const result = inspectSnapshot({ ...context, html });
  assert.deepEqual(result.productFields.map(({field,value,origin}) => ({field,value,origin})), [
    { field:'name', value:'Pack A', origin:'json-ld' }, { field:'description', value:'Small pack', origin:'json-ld' },
    { field:'price', value:'49', origin:'json-ld' }, { field:'currency', value:'USD', origin:'json-ld' },
    { field:'name', value:'Pack B', origin:'visible-html' }, { field:'price', value:'59', origin:'visible-html' }
  ]);
  for (const field of result.productFields) assert.ok(html.slice(field.location.startOffset, field.location.endOffset).includes(field.value));
  assert.equal(inspectSnapshot({ ...context, html: '<script type="application/ld+json">invalid</script>' }).productFields.length, 0);
});

test('structured extraction discloses limits and ignores hidden JSON-LD', () => {
  const script = '<script type="application/ld+json">' + JSON.stringify({ '@type':'Product', name:'Secret' }) + '</script>';
  const hidden = inspectSnapshot({ ...context, html: `<div hidden>${script}</div><template>${script}</template>` });
  assert.deepEqual(hidden.productFields, []);
  const large = inspectSnapshot({ ...context, html: '<script type="application/ld+json">' + JSON.stringify({ '@type':'Product', name:'x'.repeat(501) }) + '</script>' });
  assert.equal(large.coverage.complete, false);
  const many = inspectSnapshot({ ...context, html: '<script type="application/ld+json">' + JSON.stringify(Array.from({ length: 51 }, () => ({ '@type':'Product', name:'x' }))) + '</script>' });
  assert.equal(many.coverage.complete, false);
});

test('retained live model failure shows valid citation is not semantic correctness', async () => {
  const { validateContentResponse } = await import('../scripts/feasibility.mjs');
  const observed = JSON.parse(readFileSync('evals/fixtures/feasibility/cloudflare-live.json', 'utf8'));
  const cases = observed.ai.calls;
  for (const c of cases) assert.equal(validateContentResponse({ excerpts: [{ id:'e1', text:c.user }] }, c.response).state, c.response.state);
  assert.equal(cases[0].response.state, cases[0].expected_state);
  assert.notEqual(cases[1].response.state, cases[1].expected_state);
  const raw = inspectSnapshot({ ...context, html: observed.browser.request.html });
  assert.equal(observePhrase(raw, 'Dishwasher safe').state, 'not_observed');
  assert.match(observed.browser.response.result, /Dishwasher safe/);
});
