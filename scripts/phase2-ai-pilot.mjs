// Offline payload construction and structural proposal validation only. No model calls.
import { validateContentResponse } from './feasibility.mjs';
const encoder = new TextEncoder();
export function pilotRequest(corpus, item, settings) {
  if (!corpus || typeof corpus.instruction !== 'string' || !item || typeof item.claim !== 'string' || typeof item.evidence !== 'string') throw new Error('Invalid case');
  const user = `Claim: ${item.claim}\nEvidence e1: ${item.evidence}`;
  const messages = [{ role: 'system', content: corpus.instruction }, { role: 'user', content: user }];
  if (encoder.encode(JSON.stringify(messages)).length > 1500) throw new Error('Pilot message budget exceeded');
  if (!settings || settings.model !== '@cf/meta/llama-3.3-70b-instruct-fp8-fast' || settings.max_tokens !== 256 || settings.temperature !== 0 || settings.retries !== 0 || settings.maxCalls !== 12) throw new Error('Invalid frozen pilot settings');
  const { retries, maxCalls, model, ...body } = settings;
  const request = { ...body, messages };
  if (encoder.encode(JSON.stringify(request)).length > 2000) throw new Error('Pilot request budget exceeded');
  return { model, body: request, retries, maxCalls };
}
export function recordProposal(item, response) {
  const request = { excerpts: [{ id: 'e1', text: item.evidence }] };
  const validated = validateContentResponse(request, response);
  return { status: 'unverified', proposal: { state: validated.state, evidenceIds: validated.evidenceIds, rationale: validated.rationale }, source: { caseId: item.id, evidenceId: 'e1' }, limitation: 'No score or action; independent human semantic review of the exact evidence and proposal is required.' };
}
