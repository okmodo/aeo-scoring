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

import { assessCompleteProductFields } from './product-fields.mjs';
const assess = (record, options = {}) => assessCompleteProductFields(record, 'https://example.com/item', { observedAt: '2026-11-09T12:00:00Z', ...options });
test('complete offer assessment scores absent, partial, invalid and expired components', () => {
  assert.equal(assess({})['S2.offer'].fraction, 0);
  assert.equal(assess({offers:{'@type':'Offer',price:'19',priceCurrency:'USD'}})['S2.offer'].fraction, 0.5);
  assert.equal(assess({offers:{...offer,price:'bad'}})['S2.offer'].fraction, 0.5);
  assert.equal(assess({offers:{...offer,priceValidUntil:'2026-11-09'}})['S2.offer'].fraction, 1);
  const expired = assess({offers:{...offer,priceValidUntil:'2026-11-08'}})['S2.offer'];
  assert.equal(expired.fraction, 0.5);
  assert.match(expired.excerpt, /2026-11-08/);
  assert.equal(assess({offers:{...offer,priceValidUntil:'2026-02-30'}})['S2.offer'].fraction, 0.5);
  assert.equal(assess({offers:{...offer,priceValidUntil:'2026-11-09'}},{observedAt:undefined})['S2.offer'].status, 'not_measured');
});
test('complete offers select exact URL and assess qualified unit prices only with context', () => {
  const selected = {...offer, url:'https://example.com/item'};
  assert.equal(assess({offers:[{...offer,url:'https://example.com/other'},selected]})['S2.offer'].fraction,1);
  assert.equal(assess({offers:[selected,selected]})['S2.offer'].status,'not_measured');
  const unit = {'@type':'Offer',availability:'InStock',priceSpecification:{'@type':'UnitPriceSpecification',price:5,priceCurrency:'USD',eligibleRegion:'US'}};
  assert.equal(assess({offers:unit})['S2.offer'].status,'not_measured');
  assert.equal(assess({offers:unit},{context:{market:'US',currency:'USD'}})['S2.offer'].fraction,1);
  assert.equal(assess({offers:unit},{context:{market:'CA',currency:'USD'}})['S2.offer'].status,'not_measured');
  assert.equal(assess({offers:{...unit,price:9}} ,{context:{market:'US'}})['S2.offer'].status,'not_measured');
});
test('complete identifiers grade brand and valid identifiers independently', () => {
  for (const [record, fraction] of [[{},0],[{brand:'Acme'},0.5],[{mpn:'ABC'},0.5],[{sku:'ABC'},0.25],[{brand:'Acme',sku:'ABC'},0.75],[{brand:'Acme',gtin12:'036000291452'},1],[{gtin12:'036000291453'},0]]) assert.equal(assess(record)['S2.identifiers'].fraction,fraction);
  assert.equal(assess({brand:'Acme',gtin12:'036000291452',gtin13:'0036000291452'})['S2.identifiers'].fraction,1);
  assert.equal(assess({brand:'Acme',gtin12:'036000291452',gtin13:'4006381333931'})['S2.identifiers'].status,'not_measured');
});
