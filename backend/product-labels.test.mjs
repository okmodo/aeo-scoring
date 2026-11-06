import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreProductLabels } from './product-labels.mjs';

const product = { name: 'Acme Trail X24 Pack', brand: { '@type': 'Brand', name: 'Acme' }, model: 'X24P' };
const name = 'Acme Trail X24P Pack';
const associated = { ...product, name };

test('specific raw heading and title corroborate brand and model without copying labels', () => {
  const result = scoreProductLabels(associated, { title: name + ' | Store', mainH1: name });
  assert.equal(result['S4.title'].fraction, 1);
  assert.equal(result['C1.identity'].fraction, 1);
  assert.match(result['S4.title'].location, /main h1/);
  assert.doesNotMatch(JSON.stringify(result), /Acme|X24P/);
});

test('generic labels, incomplete fields and substring-only identifiers do not earn unsupported credit', () => {
  assert.deepEqual(scoreProductLabels({ name: 'Shoes', brand: 'Shoes' }, { title: 'Shoes', mainH1: 'Shoes' }), {});
  assert.deepEqual(scoreProductLabels(product, { title: product.name, mainH1: product.name }), {});
  assert.equal(scoreProductLabels({ ...associated, brand: 'Acm' }, { title: name, mainH1: name })['C1.identity'], undefined);
  assert.equal(scoreProductLabels(associated, { title: 'Store | ' + name, mainH1: name })['S4.title'], undefined);
});

test('missing, ambiguous, malformed or unrelated heading evidence remains unmeasured', () => {
  for (const mainH1 of [undefined, null, [name], 'Another Pack', '<b>' + name + '</b>', 'x'.repeat(301)]) {
    assert.deepEqual(scoreProductLabels(associated, { title: name, mainH1 }), {});
  }
});
