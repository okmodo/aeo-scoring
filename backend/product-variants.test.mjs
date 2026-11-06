import test from 'node:test';
import assert from 'node:assert/strict';
import { selectProductVariant } from './product-variants.mjs';

const page = 'https://shop.example/item?color=red';
const member = (color, url) => ({ '@type': 'Product', color, url, offers: { '@type': 'Offer', url, price: 12, priceCurrency: 'USD', availability: 'https://schema.org/InStock' } });
const group = () => ({ '@type': 'ProductGroup', variesBy: 'https://schema.org/color', hasVariant: [member('red', page), member('blue', '?color=blue')] });

test('selects the exact member and verifies inline variant associations', () => {
  const result = selectProductVariant(group(), page);
  assert.equal(result.selectedIndex, 0);
  assert.equal(result.variant, 'color: red');
  assert.equal(result.evidence.fraction, 1);
});

test('leaves conflicting or unsupported associations unknown', () => {
  for (const mutate of [
    g => { g.hasVariant[1].color = 'red'; },
    g => { g.hasVariant[1].url = page; },
    g => { g.hasVariant[1].offers.url = page; },
    g => { g.hasVariant[1].offers.availability = 'NotARealAvailability'; },
    g => { g.productGroupID = 'Group A'; g.hasVariant[0].inProductGroupWithID = 'Group B'; },
    g => { g.hasVariant[1].color = 'ＲＥＤ'; },
    g => { g.hasVariant[1].url = 'https://other.example/item'; },
    g => { g.hasVariant[1].isVariantOf = { '@id': '#group' }; },
    g => { g.offers = {}; },
    g => { g.variesBy = 'unknown'; },
    g => { g.hasVariant = [g.hasVariant[0]]; },
    g => { g['@context'] = { color: 'https://other.example/color' }; },
  ]) {
    const input = group(); mutate(input);
    assert.equal(selectProductVariant(input, page), null);
  }
});

test('requires an exact selected URL and handles malformed input', () => {
  assert.equal(selectProductVariant(group(), 'https://shop.example/item'), null);
  assert.equal(selectProductVariant(null, page), null);
  assert.equal(selectProductVariant(group(), 'invalid'), null);
});
