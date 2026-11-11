import test from 'node:test';
import assert from 'node:assert/strict';
import { providerNeurons } from './allowance-reconciliation.mjs';

const rates = [26668, 204805];
const usage = { prompt_tokens: 100, completion_tokens: 20, neurons: 8.1 };
const response = (u = usage, finish = 'stop') => ({ usage: u, choices: [{ finish_reason: finish }] });

test('finished stop and length responses account for root provider usage, rounded up', () => {
  assert.equal(providerNeurons(response(), ...rates), 9);
  assert.equal(providerNeurons(response(usage, 'length'), ...rates), 9);
  assert.equal(providerNeurons({ usage }, ...rates), 9);
  for (const finish of ['tool_calls', 'content_filter', null, '']) assert.equal(providerNeurons(response(usage, finish), ...rates), null);
  assert.equal(providerNeurons({usage, choices: []}, ...rates), null);
  assert.equal(providerNeurons({usage, choices: [{finish_reason:'stop'}, {finish_reason:'stop'}]}, ...rates), null);
});

test('provider values and token-derived estimates use the larger conservative charge', () => {
  assert.equal(providerNeurons(response({...usage, neurons: 100_000.1}), ...rates), 100_001);
  assert.equal(providerNeurons(response({...usage, neurons: 0}), ...rates), 7);
  const {neurons: _, ...tokens} = usage;
  assert.equal(providerNeurons(response(tokens), ...rates), 7); // Estimated from tokens, not reported neurons.
});

test('only valid root usage and positive integer tokens can authorize settlement', () => {
  for (const malformed of [
    null, {}, {response:{usage}}, {response:JSON.stringify({usage})},
    response({...usage, neurons: -1}), response({...usage, neurons: Infinity}), response({...usage, neurons: NaN}),
    response({...usage, neurons: '9'}), response({...usage, prompt_tokens: 0}),
    response({...usage, completion_tokens: 0}), response({...usage, prompt_tokens: 1.1}),
    response({...usage, completion_tokens: Infinity}), response({...usage, prompt_tokens: undefined}),
    response({...usage, completion_tokens: undefined}), response({...usage, prompt_tokens: -1}),
  ]) assert.equal(providerNeurons(malformed, ...rates), null);
});

test('invalid rate constants cannot turn incomplete arithmetic into a settlement', () => {
  for (const bad of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
    assert.equal(providerNeurons(response(), bad, rates[1]), null);
    assert.equal(providerNeurons(response(), rates[0], bad), null);
  }
});
