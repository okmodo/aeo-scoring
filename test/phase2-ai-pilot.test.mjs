import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pilotRequest,recordProposal} from '../scripts/phase2-ai-pilot.mjs';
const corpus = JSON.parse(readFileSync('evals/fixtures/feasibility/ai-pilot/cases.json','utf8'));
const settings = JSON.parse(readFileSync('evals/fixtures/feasibility/ai-pilot/settings.json','utf8'));
const original = JSON.parse(readFileSync('evals/fixtures/feasibility/cloudflare-live.json','utf8')).ai.calls[1];
test('frozen pilot is bounded, diverse and retains the original exact user message', () => {
  assert.equal(corpus.cases.length,12);
  assert.equal(new Set(corpus.cases.map(c => c.id)).size,12);
  assert.equal(pilotRequest(corpus,corpus.cases[0],settings).body.messages[1].content, original.user);
  assert.deepEqual(new Set(corpus.cases.map(c => c.expected)),new Set(['supported','unsupported','uncertain']));
  for (const c of corpus.cases) {
    const r = pilotRequest(corpus,c,settings);
    assert.equal(r.body.max_tokens,256); assert.equal(r.retries,0);
    assert.ok(Buffer.byteLength(JSON.stringify(r.body)) <= 2000);
  }
});
test('structurally valid model output is always an unverified proposal, even original failure', () => {
  const result=recordProposal(corpus.cases[0], original.response);
  assert.equal(result.status,'unverified'); assert.equal(result.proposal.state,'supported');
  assert.equal('score' in result,false); assert.match(result.limitation,/human semantic review/);
  assert.throws(() => recordProposal(corpus.cases[0],{state:'supported',evidenceIds:['e99'],rationale:'yes'}));
});

test('retained model observations preserve semantic failures and no proposal authority', () => {
  const observations = JSON.parse(readFileSync('evals/changes/phase-2-closure/ai-observations.json','utf8'));
  assert.equal(observations.issuedRequests,12);
  assert.equal(observations.coordinatorRetries,0);
  assert.equal(observations.observations.length,12);
  let valid = 0, rejected = 0, matching = 0;
  for (const [i, observed] of observations.observations.entries()) {
    const item = corpus.cases[i], frozen = pilotRequest(corpus,item,settings);
    assert.equal(observed.caseId,item.id);
    assert.deepEqual(observed.request,frozen.body);
    assert.equal(observed.requestedModel,frozen.model);
    assert.deepEqual(JSON.parse(observed.responseContent),observed.parsedResponse);
    if (observed.parsedResponse.state === item.expected) matching++;
    try {
      const proposal = recordProposal(item,observed.parsedResponse);
      assert.equal(proposal.status,'unverified');
      assert.equal('score' in proposal,false);
      valid++;
    } catch {
      assert.equal(item.id,'positive-with-injection');
      rejected++;
    }
  }
  assert.equal(matching,7);
  assert.equal(valid,11);
  assert.equal(rejected,1);
  assert.equal(observations.observations[0].parsedResponse.state,'supported');
  assert.equal(corpus.cases[0].expected,'unsupported');
});
