import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pilotRequest,recordProposal} from '../scripts/phase2-ai-pilot.mjs';
const corpus = JSON.parse(readFileSync('evals/fixtures/feasibility/ai-pilot/cases.json','utf8'));
const original = JSON.parse(readFileSync('evals/fixtures/feasibility/cloudflare-live.json','utf8')).ai.calls[1];
test('frozen pilot is bounded, diverse and retains the original exact user message', () => {
  assert.equal(corpus.cases.length,12);
  assert.equal(new Set(corpus.cases.map(c => c.id)).size,12);
  assert.equal(pilotRequest(corpus,corpus.cases[0]).messages[1].content, original.user);
  assert.deepEqual(new Set(corpus.cases.map(c => c.expected)),new Set(['supported','unsupported','uncertain']));
  for (const c of corpus.cases) {
    const r = pilotRequest(corpus,c);
    assert.equal(r.max_tokens,256); assert.equal(r.retries,0);
    assert.ok(Buffer.byteLength(JSON.stringify(r.messages)) <= 1500);
  }
});
test('structurally valid model output is always an unverified proposal, even original failure', () => {
  const result=recordProposal(corpus.cases[0], original.response);
  assert.equal(result.status,'unverified'); assert.equal(result.proposal.state,'supported');
  assert.equal('score' in result,false); assert.match(result.limitation,/human semantic review/);
  assert.throws(() => recordProposal(corpus.cases[0],{state:'supported',evidenceIds:['e99'],rationale:'yes'}));
});
