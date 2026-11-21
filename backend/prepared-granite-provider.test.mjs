import test from 'node:test';
import assert from 'node:assert/strict';
import { createGraniteProvider, GRANITE_MODEL_CONFIG as config, serializeGraniteRequest } from './granite-provider.mjs';

const input = { messages: [{ role: 'user', content: 'Return JSON' }] };
const usage = { prompt_tokens: 100, completion_tokens: 200 };
const envelope = result => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
function setup(response = () => envelope({ response: '{"ok":true}', usage }), billingMode = 'postpaid') {
  const calls = [], reservations = [], settlements = [], diagnostics = [];
  const allowance = { reserve: async x => { reservations.push(x); return { accepted: true, duplicate: false }; }, settle: async x => { settlements.push(x); return { accepted: true }; } };
  const provider = createGraniteProvider({ AUDIT_AI_GATEWAY_TOKEN: 'secret' }, { allowance, now: () => 123, onDiagnostic: x => diagnostics.push(x), fetch: async (...args) => {
    if (args[1].method === 'GET') {
      assert.equal(args[0], config.gatewayEndpoint);
      return envelope({ id: 'default', workers_ai_billing_mode: billingMode });
    }
    calls.push(args);
    return response();
  } });
  return { provider, allowance, calls, reservations, settlements, diagnostics };
}
const run = s => s.provider.run(config.model, input);
test('sends bounded Granite request and settles root usage', async () => {
  const s = setup(); const result = await run(s);
  assert.deepEqual(result, { response: { ok: true }, usage });
  assert.equal(s.calls[0][0], config.endpoint);
  assert.deepEqual(JSON.parse(s.calls[0][1].body), { messages: input.messages, max_tokens: 8192, temperature: 0, stream: false });
  assert.equal(s.calls[0][1].headers['cf-aig-gateway-id'], 'default');
  assert.equal(s.calls[0][1].body, serializeGraniteRequest(input));
  assert.ok(s.reservations[0].costs.aiNeurons > 83);
  assert.deepEqual(s.settlements[0], { id: s.reservations[0].id, costs: { aiNeurons: 3 }, now: 123 });
});
test('denied admission and oversized requests never fetch', async () => {
  const s = setup(); s.allowance.reserve = async () => ({ accepted: false });
  await assert.rejects(run(s), /admission_failed/); assert.equal(s.calls.length, 0);
  await assert.rejects(s.provider.run(config.model, { messages: [{ role: 'user', content: 'x'.repeat(62000) }] }), /request_limit/);
  assert.equal(s.calls.length, 0);
});
test('settles malformed content and incomplete choices, keeping unknown usage held', async () => {
  for (const result of [{ response: 'not json', usage }, { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '{}' } }], usage }]) {
    const s = setup(() => envelope(result)); await assert.rejects(run(s)); assert.equal(s.settlements.length, 1);
  }
  const s = setup(() => envelope({ response: '{}' })); assert.deepEqual(await run(s), { response: {} }); assert.equal(s.settlements.length, 0);
});
test('supports completed chat choices and rejects overrun', async () => {
  const s = setup(() => envelope({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }], usage }));
  assert.deepEqual((await run(s)).response, {});
  s.allowance.settle = async () => ({ accepted: true, overrun: true });
  await assert.rejects(run(s)); assert.deepEqual(s.diagnostics.at(-1), { phase: 'overrun' });
});
test('propagates caller signal and rejects oversized, malformed or failed responses without leaking details', async () => {
  for (const response of [new Response('x'.repeat(65537)), new Response('{'), new Response('secret', { status: 500 })]) {
    const s = setup(() => response); const controller = new AbortController();
    await assert.rejects(s.provider.run(config.model, input, { signal: controller.signal }));
    assert.equal(s.calls[0][1].signal, controller.signal); assert.equal(s.settlements.length, 0);
    assert.ok(!JSON.stringify(s.diagnostics).includes('secret'));
  }
});

test('never starts Granite after the caller times out during admission', async () => {
  const s = setup();
  const controller = new AbortController();
  s.allowance.reserve = async () => {
    controller.abort(Error('model_timeout'));
    return { accepted: true, duplicate: false };
  };
  await assert.rejects(s.provider.run(config.model, input, { signal: controller.signal }), /model_timeout/);
  assert.equal(s.calls.length, 0);
  assert.equal(s.settlements[0].costs.aiNeurons, 0);
});

test('denies an unverified or prepaid gateway before reserving or inferring', async () => {
  for (const billingMode of ['prepaid', null]) {
    const s = setup(undefined, billingMode);
    await assert.rejects(run(s), /model_provider_failure/);
    assert.equal(s.calls.length, 0);
    assert.equal(s.reservations.length, 0);
    assert.deepEqual(s.diagnostics.at(-1), { phase: 'billing' });
  }
});
test('keeps the hold if the provider responds after the caller aborts', async () => {
  const controller = new AbortController();
  const s = setup(() => {
    controller.abort(Error('model_timeout'));
    return envelope({ response: '{}', usage });
  });
  await assert.rejects(s.provider.run(config.model, input, { signal: controller.signal }), /model_timeout/);
  assert.equal(s.reservations.length, 1);
  assert.equal(s.settlements.length, 0);
});
