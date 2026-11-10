import { buildJudgeInput, decodeJudgeOutput } from './semantic-transport.mjs';
import { inspectProductSchema } from './structure-assessment.mjs';
import { buildSemanticRequest, SEMANTIC_MODEL } from './semantic-assessment.mjs';
export const SEMANTIC_CALIBRATION_APPROVED = false;
// Conservative reservation, not measured billing. No retries or paid fallback.
export function semanticModelInput(prepared) { return buildJudgeInput(prepared); }
export function semanticOutput(output) {
    if (output?.response != null)
        return output.response;
    if (Array.isArray(output?.output))
        return output.output.filter(item => item.type === 'message' && item.role === 'assistant').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('');
    return output?.choices?.[0]?.message?.content ?? output;
}
export function semanticReservation(input) {
    const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    if (bytes > 60 * 1024)
        throw new Error('Semantic request exceeds budgeted input');
    return Math.ceil((bytes + 2048) * 31818 / 1000000 + (input.max_output_tokens ?? input.max_tokens) * 68182 / 1000000) + 64;
}
export async function assessWithSemanticJudge({ AI, store, now = Date.now, snapshot, extracted, report, calibrationApproved = SEMANTIC_CALIBRATION_APPROVED }) {
    if (!AI?.run || !store?.reserveSemantic)
        return { status: 'unavailable', reason: 'Semantic assessment is unavailable; unresolved content checks remain unmeasured.' };
    if (!calibrationApproved)
        return { status: 'unavailable', reason: 'Semantic scoring is awaiting independent calibration. Unresolved content checks remain unmeasured.' };
    const prepared = buildSemanticRequest(snapshot, extracted, report, { product: inspectProductSchema(snapshot, extracted).product });
    if (prepared.unsafeInstructions || prepared.payload.coverage.unsafeInstructions)
        return { status: 'unsafe_content', reason: 'Instruction-like product text prevents a reliable semantic assessment. Unresolved checks remain unmeasured.' };
    if (!prepared.payload.category)
        return { status: 'unsupported_category', reason: 'Category-specific semantic assessment requires a supported category.' };
    const input = semanticModelInput(prepared);
    let reserved;
    try {
        reserved = semanticReservation(input);
        const day = Math.floor(now() / 86400000);
        if (!await store.reserveSemantic({ day, neurons: reserved }))
            return { status: 'budget_exhausted', reason: 'The daily semantic assessment allowance has been reached. Unresolved checks remain unmeasured.' };
    }
    catch {
        return { status: 'unavailable', reason: 'Semantic assessment budget could not be reserved.' };
    }
    let timer;
    try {
        // AI binding currently has no cancellation primitive; at most one bounded
        // invocation is issued. A timed-out invocation retains its full reservation.
        const output = await Promise.race([AI.run(SEMANTIC_MODEL, input), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Semantic timeout')), 20000); })]);
        const result = decodeJudgeOutput(prepared, input, Array.isArray(output?.output) ? output : semanticOutput(output));
        return { status: 'assessed', ...result, model: SEMANTIC_MODEL, reservedNeurons: reserved };
    }
    catch {
        return { status: 'unavailable', reason: 'Semantic assessment did not return a supported, grounded result.' };
    }
    finally {
        clearTimeout(timer);
    }
}
