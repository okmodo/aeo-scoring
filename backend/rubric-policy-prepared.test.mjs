import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scorePreparedPolicies } from './rubric-policy.mjs';

const url = 'https://example.test/product';
const product = (...texts) => ({ productHtml: { complete: true, blocks: texts.map((text, i) => ({ text, location: `product:${i}` })), headings: [] } });
const policy = (kind, text, extra = {}) => ({ [kind]: { state: 'read', url: `https://example.test/${kind}`, extraction: { complete: true, blocks: [{ text, location: 'policy' }], ...extra } } });
const score = (derived, policies = {}) => scorePreparedPolicies({ url }, derived, policies);

test('scores complete, explicitly applicable shipping and returns terms', () => {
  const shipping = 'All products ship to the United States. Free shipping. Delivery takes 3 to 5 business days.';
  const returns = 'All products: unused items may be returned within 30 days in original packaging.';
  const findings = score(product(), { ...policy('shipping', shipping), ...policy('returns', returns) });
  assert.equal(findings['C3.shipping'].fraction, 1);
  assert.equal(findings['C3.returns'].fraction, 1);
  assert.equal(findings['C3.shipping'].evidence[0].url, 'https://example.test/shipping');
});

test('does not infer complete terms from generic timelines, exceptions, or incomplete policies', () => {
  assert.equal(score(product('This product: free shipping to the United States. Warranty lasts 30 days.'))['C3.shipping'].status, 'not_measured');
  assert.equal(score(product(), policy('returns', 'All products: unused items may be returned within 30 days in original packaging.', { truncated: true }))['C3.returns'].status, 'not_measured');
  assert.equal(score(product(), policy('returns', 'All products: unused items may be returned within 30 days in original packaging, except select items.'))['C3.returns'].status, 'not_measured');
});

test('preserves explicit final sale and pickup only, and detects conflicting claims', () => {
  assert.equal(score(product('This product is final sale.'))['C3.returns'].fraction, 1);
  assert.equal(score(product('This product is available for pickup only. Shipping is unavailable.'))['C3.shipping'].status, 'not_applicable');
  assert.equal(score(product('This product is available for pickup only. Shipping is unavailable.', 'This product ships to the United States.'))['C3.shipping'].status, 'not_measured');
  assert.equal(score(product('This product ships to the United States. Free shipping. Delivery takes 3 days.', 'Shipping costs are not provided.'))['C3.shipping'].status, 'not_measured');
});

test('incomplete product evidence cannot establish a policy', () => {
  const derived = product('This product ships to the United States. Free shipping. Delivery takes 3 days.');
  derived.productHtml.truncated = true;
  assert.equal(score(derived)['C3.shipping'].status, 'not_measured');
  assert.match(score(derived)['C3.shipping'].reason, /incomplete/i);
});

test('pickup-only cannot be reconciled with positive shipping terms', () => {
  const finding = score(product('This product is available for pickup only. Shipping is unavailable.',
    'This product ships to the United States. Free shipping. Delivery takes 3 days.'))['C3.shipping'];
  assert.equal(finding.status, 'not_measured');
  assert.match(finding.reason, /conflict/i);
});

test('conflicting missing and present terms in one block do not establish a failure', () => {
  const finding = score(product(), policy('shipping', 'All products: shipping costs are not provided. Free shipping.'))['C3.shipping'];
  assert.equal(finding.status, 'not_measured');
});

test('final sale conflicts with a directly stated return allowance, even in one block', () => {
  for (const blocks of [
    ['This product is final sale. This product may be returned within 30 days.'],
    ['This product is final sale.', 'This product may be returned within 30 days.'],
  ]) {
    const finding = score(product(...blocks))['C3.returns'];
    assert.equal(finding.status, 'not_measured');
    assert.match(finding.reason, /conflict/i);
  }
});

test('negated return conditions do not establish a return policy pass', () => {
  const finding = score(product('This product: unused items cannot be returned within 30 days in original packaging.'))['C3.returns'];
  assert.equal(finding.status, 'not_measured');
  assert.match(finding.reason, /restriction/i);
  assert.equal(score(product('This product is final sale. Returns are not accepted.'))['C3.returns'].fraction, 1);
});

test('unmeasured findings cite bounded partial evidence and identify unresolved terms', () => {
  const text = 'This product ships to the United States. Free shipping.';
  const finding = score(product(text))['C3.shipping'];
  assert.equal(finding.status, 'not_measured');
  assert.match(finding.reason, /delivery timing/);
  assert.deepEqual(finding.evidence, [{ url, location: 'product:0', excerpt: text }]);
  assert.ok(finding.evidence.length <= 3);
});

test('negated shipping coverage does not score alongside free shipping and a timeline', () => {
  const mixed = product('This product does not ship to the United States. Free shipping. Delivery takes 3 days.');
  assert.equal(score(mixed)['C3.shipping'].status, 'not_measured');
});

test('a negated return clause cannot hide an affirmative return allowance against final sale', () => {
  const mixed = product('This product is final sale. Returns are not accepted, but this product may be returned within 30 days.');
  assert.equal(score(mixed)['C3.returns'].status, 'not_measured');
});

test('an explicit, non-conflicting missing policy term earns binary zero', () => {
  const findings = score(product(), policy('shipping', 'All products: shipping costs are not provided.'));
  assert.equal(findings['C3.shipping'].status, 'measured');
  assert.equal(findings['C3.shipping'].fraction, 0);
  assert.equal(findings['C3.shipping'].evidence[0].url, 'https://example.test/shipping');
});
