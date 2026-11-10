import { buildSemanticRequest } from './semantic-assessment.mjs';
import { inspectProductSchema } from './structure-assessment.mjs';
import { buildContentFactsRequest, decodeContentFacts, CONTENT_FACTS_MODEL } from './content-facts.mjs';

// Enable only after independent live calibration and an explicit decision.
export const CONTENT_FACTS_CALIBRATION_APPROVED = false;
const MAX_INPUT_BYTES = 60 * 1024;
const MAX_OUTPUT_TOKENS = 2048;
const TIMEOUT_MS = 20_000;

/** Conservative reservation at published model rates, plus fixed overhead.
 * A byte is counted as one input token; failures and timeouts are never refunded. */
export function contentFactsReservation(input) {
    const size = new TextEncoder().encode(JSON.stringify(input)).length;
    if (size > MAX_INPUT_BYTES || !Number.isSafeInteger(input?.max_tokens) || input.max_tokens < 1 || input.max_tokens > MAX_OUTPUT_TOKENS) throw new Error('Content facts request exceeds budget');
    return Math.ceil((size + 2048) * 26668 / 1_000_000 + input.max_tokens * 204805 / 1_000_000) + 64;
}
function contentOutput(output) {
    if (output?.response != null) return output.response;
    if (typeof output?.output_text === 'string') return output.output_text;
    if (Array.isArray(output?.output)) {
        const parts = output.output.filter(item => item.type === 'message' && item.role === 'assistant').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text);
        if (parts.length !== 1) throw new Error('Missing or ambiguous model output');
        return parts[0];
    }
    return output?.choices?.[0]?.message?.content ?? output;
}
/** The optional calibration and timer arguments are for internal offline tests only. */
export async function assessWithContentFacts({ AI, store, now = Date.now, snapshot, extracted, report, calibrationApproved = CONTENT_FACTS_CALIBRATION_APPROVED, setTimer = setTimeout, clearTimer = clearTimeout }) {
    if (!AI?.run || !store?.reserveSemantic) return { status: 'unavailable', reason: 'Content fact assessment is unavailable; unresolved checks remain unmeasured.' };
    if (!calibrationApproved) return { status: 'unavailable', reason: 'Content fact assessment is awaiting independent calibration; unresolved checks remain unmeasured.' };
    let prepared, input, reserved;
    try {
        prepared = buildSemanticRequest(snapshot, extracted, report, { product: inspectProductSchema(snapshot, extracted).product });
        if (prepared.unsafeInstructions || prepared.payload.coverage.unsafeInstructions) return { status: 'unsafe_content', reason: 'Instruction-like product content prevents a reliable assessment; unresolved checks remain unmeasured.' };
        if (!prepared.payload.category) return { status: 'unsupported_category', reason: 'Content fact assessment requires a supported product category.' };
        input = buildContentFactsRequest(prepared);
        reserved = contentFactsReservation(input);
    } catch {
        return { status: 'unavailable', reason: 'Content fact assessment could not prepare a safe bounded request.' };
    }
    try {
        if (!await store.reserveSemantic({ day: Math.floor(now() / 86_400_000), neurons: reserved })) return { status: 'budget_exhausted', reason: 'The daily content assessment allowance has been reached; unresolved checks remain unmeasured.' };
    } catch {
        return { status: 'unavailable', reason: 'Content assessment budget could not be reserved.' };
    }
    let timer;
    try {
        // The AI binding has no cancellation primitive; an expired call retains its reservation.
        const output = await Promise.race([AI.run(CONTENT_FACTS_MODEL, input), new Promise((_, reject) => { timer = setTimer(() => reject(new Error('Content facts timeout')), TIMEOUT_MS); })]);
        const facts = decodeContentFacts(prepared, input, contentOutput(output), {requireConditionChecks:true});
        return { status: 'assessed', facts, model: CONTENT_FACTS_MODEL, reservedNeurons: reserved };
    } catch {
        return { status: 'unavailable', reason: 'Content fact assessment did not return a supported, grounded result.' };
    } finally {
        if (timer !== undefined) clearTimer(timer);
    }
}
