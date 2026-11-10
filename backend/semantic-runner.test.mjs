import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWithSemanticJudge, semanticReservation } from './semantic-runner.mjs';
const snapshot = { url: 'https://shop.example/item' };
const extracted = { productHtml: { complete: true, identity: { mainH1: 'Acme T-shirt' }, blocks: [{ text: 'Selected Regular T-shirt, 100% cotton.', location: 'main/p' }] } };
const report = { category: 'basic-tshirts' };
test('reserves before one bounded model call and keeps failure reservations', async () => {
    const events = [];
    const result = await assessWithSemanticJudge({ calibrationApproved: true, snapshot, extracted, report, store: { reserveSemantic: async (input) => { events.push(['reserve', input]); return true; } }, AI: { run: async (_model, input) => { events.push(['run', input]); throw new Error('provider unavailable'); } }, now: () => 86400000 });
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(events.map(e => e[0]), ['reserve', 'run']);
    assert.equal(events[0][1].day, 1);
    assert.ok(events[0][1].neurons > 0 && events[0][1].neurons <= 2000);
    assert.equal(events[1][1].reasoning.effort, 'low');
    assert.equal(events[1][1].max_output_tokens, 3072);
});
test('exhausted quota, unsupported category, and missing integration do not invoke a model', async () => {
    const AI = { run: () => assert.fail('Unexpected inference') };
    assert.equal((await assessWithSemanticJudge({ calibrationApproved: true, snapshot, extracted, report, AI, store: { reserveSemantic: async () => false } })).status, 'budget_exhausted');
    assert.equal((await assessWithSemanticJudge({ calibrationApproved: true, snapshot, extracted, report: { category: null }, AI, store: { reserveSemantic: async () => assert.fail('No reservation for unknown category') } })).status, 'unsupported_category');
    assert.equal((await assessWithSemanticJudge({ calibrationApproved: true, snapshot, extracted, report })).status, 'unavailable');
});
test('oversized requests and malformed model answers fail without retries', async () => {
    assert.throws(() => semanticReservation({ messages: ['x'.repeat(65000)], max_tokens: 4096 }));
    let calls = 0;
    const result = await assessWithSemanticJudge({ calibrationApproved: true, snapshot, extracted, report, AI: { run: async () => { calls++; return { response: 'I refuse' }; } }, store: { reserveSemantic: async () => true } });
    assert.equal(result.status, 'unavailable');
    assert.equal(calls, 1);
});
test('production semantic scoring remains disabled until independently calibrated', async () => {
    const result = await assessWithSemanticJudge({ snapshot, extracted, report, AI: { run: () => assert.fail('Uncalibrated model must not run') }, store: { reserveSemantic: () => assert.fail('No reservation while disabled') } });
    assert.equal(result.status, 'unavailable');
    assert.match(result.reason, /calibration/);
});
