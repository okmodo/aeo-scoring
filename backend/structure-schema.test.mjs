import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectRevisedProductSchema } from './structure-schema.mjs';
import { productHtmlAccumulator } from './html-product.mjs';
import { HtmlTestRewriter } from './html-product-test-helper.mjs';
const matrix = JSON.parse(readFileSync(new URL('./fixtures/revised-s1-s2/s2-matrix.json', import.meta.url)));
const url = 'https://example.test/product';
const product = { '@type': 'Product', name: 'Shoe', url, gtin12: '036000291452', offers: { '@type': 'Offer', price: '12.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' } };
const group = { '@context': 'https://schema.org', '@type': 'ProductGroup', variesBy: 'size', hasVariant: [{ ...product, size: 'S' }, { ...product, url: 'https://example.test/large', size: 'L' }] };
function inspect(record, html = {}, extra = {}) {
  return inspectRevisedProductSchema({ url }, { coverage: { jsonLdTruncated: false }, productHtml: { complete: true, ...html }, jsonLd: record === null ? [] : [JSON.stringify(record)], ...extra });
}
const fraction = (r, k) => r.findings[`S2.${k}`]?.fraction ?? r.findings[`S2.${k}`]?.status;
test('frozen happy matrix: family modeling does not depend on offers on every variant', () => {
  const r = inspect(group);
  for (const [k, value] of Object.entries(matrix.cases.happy)) assert.equal(fraction(r, k), value, k);
});
test('partial and failure cases score only supported anchors', () => {
  const partial = inspect({ '@context': 'https://schema.org', ...product, sku: 'local', gtin12: undefined, offers: { '@type': 'Offer', availability: 'InStock' }, isVariantOf: { '@id': '#family' } });
  assert.equal(fraction(partial, 'offer'), 0.5);
  assert.equal(fraction(partial, 'identifiers'), matrix.cases.partial.identifiers);
  assert.equal(fraction(partial, 'variants'), matrix.cases.partial.variants);
  const missing = inspect(null);
  for (const k of ['syntax', 'entity', 'offer']) assert.equal(fraction(missing, k), matrix.cases.zero[k], k);
  assert.equal(fraction(missing, 'variants'), undefined);
  assert.equal(fraction(missing, 'identifiers'), undefined);
  const wrong = inspect({ '@context': 'https://schema.org', ...product, url: 'https://example.test/other' });
  assert.equal(fraction(wrong, 'entity'), 0);
  const ambiguous = inspect({ '@context': 'https://schema.org', '@type': 'Product', name: 'Unknown' });
  assert.equal(fraction(ambiguous, 'entity'), 0.5);
});
test('explicit exclusions and incomplete inspections do not invent absence', () => {
  const single = inspect({ '@context': 'https://schema.org', '@type': 'Product', url }, { singleConfiguration: true, sourceObservation: { complete: true, regions: 1, blocks: [{ text: 'No GTIN or MPN has been assigned to this product.' }, { text: 'Only one configuration.' }] } });
  assert.equal(fraction(single, 'variants'), matrix.cases.notApplicable.variants);
  assert.equal(fraction(single, 'identifiers'), matrix.cases.notApplicable.identifiers);
  const incomplete = inspect(null, { complete: false });
  for (const key of Object.keys(matrix.cases.unknown)) assert.equal(fraction(incomplete, key) ?? 'not_measured', 'not_measured');
  const malformed = inspect(null, {}, { jsonLd: ['{'] });
  assert.equal(fraction(malformed, 'syntax'), 0);
  assert.equal(fraction(malformed, 'entity'), undefined);
  assert.equal(fraction(malformed, 'offer'), undefined);
});
test('supported microdata and RDFa records and invalid identifiers', () => {
  for (const format of ['microdata', 'RDFa']) {
    const r = inspect(null, { structuredRecords: [{ complete: true, format, record: { ...product, gtin12: '036000291453' } }] });
    assert.equal(fraction(r, 'syntax'), 0.5);
    assert.equal(fraction(r, 'entity'), 1);
    assert.equal(fraction(r, 'identifiers'), 0);
  }
});
test('Offer fields and variant family relationships are assessed independently', () => {
  const bare = inspect({ '@context': 'https://schema.org', ...product, offers: { '@type': 'Offer' }, customVocabulary: 'valid extension' });
  assert.equal(fraction(bare, 'syntax'), undefined);
  assert.equal(fraction(bare, 'offer'), 0.5);
  const wrong = structuredClone(group);
  wrong.hasVariant[1].offers = { '@type': 'Offer', itemOffered: { url } };
  assert.equal(fraction(inspect(wrong), 'variants'), 1);
  const partial = structuredClone(group);
  delete partial.hasVariant[1].offers;
  assert.equal(fraction(inspect(partial), 'variants'), 1);
});

test('identifier applicability and contradictory single-configuration evidence remain unknown or partial', () => {
  const r = inspect({ '@context': 'https://schema.org', '@type': 'Product', url });
  assert.equal(fraction(r, 'identifiers'), 'not_measured');
  const conflicting = inspect(group, { singleConfiguration: true, hasVariantControls: true });
  assert.notEqual(fraction(conflicting, 'variants'), 'not_applicable');
});

test('unknown vocabulary is unmeasured and an invalid GTIN is not rescued by SKU', () => {
  const extra = inspect({ '@context': 'https://schema.org', ...product, manufacturer: { '@type': 'Organization', name: 'Maker' } });
  assert.equal(fraction(extra, 'syntax'), undefined);
  const invalid = inspect({ '@context': 'https://schema.org', ...product, gtin12: '036000291453', sku: 'ABC' });
  assert.equal(fraction(invalid, 'identifiers'), 0);
  assert.match(invalid.findings['S2.identifiers'].excerpt, /gtin12=036000291453/);
});

test('Offer itemOffered identifiers preserve fragments and require Product identity', () => {
  const offer = { '@type': 'Offer', price: '12', priceCurrency: 'USD', availability: 'InStock' };
  const withId = { '@context': 'https://schema.org', ...product, '@id': '#product', offers: { ...offer, itemOffered: { '@id': '#product' } } };
  assert.equal(fraction(inspect(withId), 'offer'), 1);
  const wrong = { ...withId, offers: { ...offer, itemOffered: { '@id': '#wrong' } } };
  assert.equal(fraction(inspect(wrong), 'offer'), 0);
  const unresolved = { ...wrong }; delete unresolved['@id'];
  assert.equal(fraction(inspect(unresolved), 'offer'), 'not_measured');
  const mixed = { ...withId, offers: [withId.offers, wrong.offers] };
  assert.equal(fraction(inspect(mixed), 'offer'), 0);
});

test('exclusions require filtered product-source claims, not reviews', async () => {
  async function fromHtml(body) {
    const rewriter = new HtmlTestRewriter(), collector = productHtmlAccumulator(rewriter);
    await rewriter.transform(new Response(body)).text();
    return collector.finish();
  }
  const claims = '<p>No GTIN or MPN has been assigned to this product.</p><p>Only one configuration.</p>';
  const record = { '@context': 'https://schema.org', '@type': 'Product', url };
  const review = await fromHtml(`<main><h1>Product</h1><section class="reviews">${claims}</section></main>`);
  const reviewResult = inspect(record, review);
  assert.notEqual(fraction(reviewResult, 'identifiers'), 'not_applicable');
  assert.notEqual(fraction(reviewResult, 'variants'), 'not_applicable');
  const main = await fromHtml(`<main><h1>Product</h1>${claims}</main>`);
  const mainResult = inspect(record, main);
  assert.equal(fraction(mainResult, 'identifiers'), 'not_applicable');
  assert.equal(fraction(mainResult, 'variants'), 'not_applicable');
  const supplied = inspect({ ...record, gtin12: 'invalid' }, main);
  assert.equal(fraction(supplied, 'identifiers'), 0);
});

test('single-configuration proof accepts an affirmative sentence in product text only', () => {
  const record = { '@context': 'https://schema.org', '@type': 'Product', url };
  const withBlock = text => inspect(record, { sourceObservation: { complete: true, regions: 1, blocks: [{ text }] } });
  assert.equal(fraction(withBlock('Includes one T-shirt. This product is offered in a single configuration.'), 'variants'), 'not_applicable');
  for (const claim of ['The reviewer said "This product is offered in a single configuration."', 'This product is not offered in a single configuration.', 'Another product is offered in a single configuration.']) {
    assert.notEqual(fraction(withBlock(claim), 'variants'), 'not_applicable', claim);
  }
});

test('other supplied external identifiers prevent identifier exclusion', () => {
  const html = { sourceObservation: { complete: true, regions: 1, blocks: [{ text: 'No GTIN or MPN has been assigned to this product.' }] } };
  for (const key of ['asin', 'isbn', 'identifier', 'productID']) {
    const result = inspect({ '@context': 'https://schema.org', '@type': 'Product', url, [key]: 'ABC123' }, html);
    assert.equal(fraction(result, 'identifiers'), 'not_measured', key);
  }
});
