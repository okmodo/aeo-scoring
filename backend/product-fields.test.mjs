import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreProductFields } from './product-fields.mjs';

const offer = { '@type': 'Offer', price: '19.99', priceCurrency: 'USD', availability: 'https://schema.org/InStock' };

test('scores complete associated offer and valid GTIN without echoing source values', () => {
  const result = scoreProductFields({ offers: offer, brand: { '@type': 'Brand', name: 'Private brand' }, gtin12: '036000291452' });
  assert.equal(result['S2.offer'].fraction, 1);
  assert.equal(result['S2.offer'].currency, 'USD');
  assert.equal(result['S2.identifiers'].fraction, 1);
  assert.doesNotMatch(JSON.stringify(result), /Private brand|036000291452|19\.99/);
});

test('recognizes manufacturer part number and gives SKU partial credit with brand', () => {
  assert.equal(scoreProductFields({ brand: 'Acme', mpn: 'ABC' })['S2.identifiers'].fraction, 1);
  assert.equal(scoreProductFields({ brand: 'Acme', sku: '123' })['S2.identifiers'].fraction, 0.75);
  assert.equal(scoreProductFields({ sku: '123' })['S2.identifiers'].fraction, 0.25);
});

test('leaves incomplete, ambiguous, and scoped offers unmeasured', () => {
  for (const offers of [undefined, [offer, offer], { ...offer, '@type': 'AggregateOffer' }, { ...offer, '@type': 'https://foreign.example/Offer' }, { ...offer, priceCurrency: 'ZZZ' }, { ...offer, price: '-1' }, { ...offer, availability: 'https://foreign.example/InStock' }, { ...offer, eligibleRegion: 'US' }, { ...offer, price: undefined }]) {
    assert.equal(scoreProductFields({ offers })['S2.offer'], undefined);
  }
});

test('leaves malformed and ambiguous identifiers unmeasured', () => {
  for (const fields of [{ brand: 'Acme', gtin12: '036000291453' }, { brand: 'Acme', gtin8: '036000291452' }, { brand: 'Acme', gtin: 36000291452 }, { brand: 'Acme', gtin: '036000291452', gtin12: '036000291452' }, { brand: { '@type': 'https://foreign.example/Brand', name: 'Acme' }, mpn: 'abc' }, { brand: 'Acme', mpn: {} }]) {
    assert.equal(scoreProductFields(fields)['S2.identifiers'], undefined);
  }
});


test('scores explicitly absent offer components but not malformed components', () => {
  assert.equal(scoreProductFields({ offers: { '@type': 'Offer', price: 5, priceCurrency: 'USD' } })['S2.offer'].fraction, 0.5);
  assert.equal(scoreProductFields({ offers: { '@type': 'Offer', availability: 'https://schema.org/InStock' } })['S2.offer'].fraction, 0.5);
  assert.deepEqual(scoreProductFields({ offers: { '@type': 'Offer', price: 5, availability: 'https://schema.org/InStock' } }), {});
  assert.deepEqual(scoreProductFields({ offers: { ...offer, availability: null } }), {});
});

test('requires an explicit offer URL to match the audited URL', () => {
  const url = 'https://example.com/product?variant=1';
  assert.equal(scoreProductFields({ offers: { ...offer, url } }, url)['S2.offer'].fraction, 1);
  assert.deepEqual(scoreProductFields({ offers: { ...offer, url: '?variant=2' } }, url), {});
  assert.deepEqual(scoreProductFields({ offers: { ...offer, url } }), {});
});

test('SKU alone requires an absent brand and no conflicting identifier', () => {
  assert.deepEqual(scoreProductFields({ sku: '123', brand: null }), {});
  assert.deepEqual(scoreProductFields({ sku: '123', gtin: 'invalid' }), {});
});
