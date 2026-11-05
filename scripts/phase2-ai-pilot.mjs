// Offline payload construction and structural proposal validation only. No model calls.
import { validateContentResponse } from './feasibility.mjs';
const encoder = new TextEncoder();
export function pilotRequest(corpus, item) {
  if (!corpus || typeof corpus.instruction !== 'string' || !item || typeof item.claim !== 'string' || typeof item.evidence !== 'string') throw new Error('Invalid case');
  const user = `Claim: ${item.claim}\nEvidence e1: ${item.evidence}`;
  const messages = [{ role: 'system', content: corpus.instruction }, { role: 'user', content: user }];
  if (encoder.encode(JSON.stringify(messages)).length > 1500) throw new Error('Pilot message budget exceeded');
  return { messages, max_tokens: 256, temperature: 0, retries: 0 };
}
export function recordProposal(item, response) {
  const request = { excerpts: [{ id: 'e1', text: item.evidence }] };
  const validated = validateContentResponse(request, response);
  return { status: 'unverified', proposal: { state: validated.state, evidenceIds: validated.evidenceIds, rationale: validated.rationale }, source: { caseId: item.id, evidenceId: 'e1' }, limitation: 'No score or action; independent human semantic review of the exact evidence and proposal is required.' };
}
