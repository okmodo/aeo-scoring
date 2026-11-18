import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipelineState } from './pipeline-state.mjs';

test('stage diagnostics preserve ordered safe codes and are copied on read', async () => {
  const writes = [];
  const db = { prepare(sql) { assert.match(sql, /ON CONFLICT/); return { bind(...args) { return { async run() { writes.push(args); } }; } }; } };
  const state = createPipelineState({ db, auditId: 'audit', now: () => 100 });
  await state.record('retrieval', 'completed', 'downloaded');
  await state.record('category', 'failed', 'ambiguous_product');
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1][2])[1].code, 'ambiguous_product');
  state.summary().stages[0].code = 'changed';
  assert.equal(state.summary().stages[0].code, 'downloaded');
  await assert.rejects(state.record('category', 'failed', 'Secret/raw exception!'));
  await assert.rejects(state.record('unexpected', 'failed', 'failure'));
});

test('diagnostic persistence failure is observable rather than silently dropped', async () => {
  const state = createPipelineState({ auditId: 'audit', db: { prepare() { throw new Error('offline'); } } });
  await assert.rejects(state.record('snapshot', 'running', 'persisting'), /offline/);
});
