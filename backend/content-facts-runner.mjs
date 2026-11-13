import { buildSemanticRequest } from './semantic-assessment.mjs';
import { inspectProductSchema } from './structure-assessment.mjs';
import { buildContentFactsRequest, decodeContentFacts, buildConditionInspectionRequest, decodeConditionInspection, CONTENT_FACTS_MODEL } from './content-facts.mjs';
import { assessContentFacts } from './fact-grading.mjs';
import { providerNeurons } from './allowance-reconciliation.mjs';

// Enable only after independent live calibration and an explicit decision.
export const CONTENT_FACTS_CALIBRATION_APPROVED = false;
export const CONTENT_FACTS_RELEASE_ID = 'content-facts-2026-11-12-r8';
const MAX_INPUT_BYTES = 60 * 1024;
const MAX_OUTPUT_TOKENS = 2048;
const TIMEOUT_MS = 20_000;
function neuronBound(inputTokens, outputTokens) {
    return Math.ceil(inputTokens * 26668 / 1_000_000 + outputTokens * 204805 / 1_000_000) + 64;
}

/** Conservative reservation at published model rates, plus fixed overhead.
 * A byte is counted as one input token; failures and timeouts are never refunded. */
export function contentFactsReservation(input) {
    const size = new TextEncoder().encode(JSON.stringify(input)).length;
    if (size > MAX_INPUT_BYTES || !Number.isSafeInteger(input?.max_tokens) || input.max_tokens < 1 || input.max_tokens > MAX_OUTPUT_TOKENS) throw new Error('Content facts request exceeds budget');
    return neuronBound(size + 2048, input.max_tokens);
}

// Capacity stays allocated to this one assessment in D1. Only completed,
// provider-root usage can establish room for one sequential suballocation.
export function contentFactsCompletedBound(firstInput, firstOutput) {
    try {
        const usage = firstOutput?.usage;
        const prompt = usage?.prompt_tokens, completion = usage?.completion_tokens;
        if (!Number.isSafeInteger(prompt) || prompt < 1 ||
            !Number.isSafeInteger(completion) || completion < 1 || completion > firstInput.max_tokens ||
            prompt > new TextEncoder().encode(JSON.stringify(firstInput)).length + 2048 ||
            !Array.isArray(firstOutput.choices) || firstOutput.choices.length !== 1 || firstOutput.choices[0]?.finish_reason !== 'stop') return null;
        if (usage.neurons !== undefined && (!Number.isFinite(usage.neurons) || usage.neurons < 0)) return null;
        return Math.max(neuronBound(prompt + 2048, completion), Math.ceil(usage.neurons ?? 0));
    } catch { return null; }
}
export function contentFactsFollowupFits(reserved, firstInput, firstOutput, followup, reservedAt, currentTime) {
    try {
        const consumed = contentFactsCompletedBound(firstInput, firstOutput);
        return consumed !== null && reserved === contentFactsReservation(firstInput) &&
            Number.isSafeInteger(reservedAt) && Number.isSafeInteger(currentTime) && currentTime >= reservedAt &&
            new Date(reservedAt).toISOString().slice(0, 10) === new Date(currentTime).toISOString().slice(0, 10) &&
            consumed + contentFactsReservation(followup) <= reserved;
    } catch { return false; }
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
export async function assessWithContentFacts({ AI, allowance, now = Date.now, snapshot, extracted, report, calibrationApproved = CONTENT_FACTS_CALIBRATION_APPROVED, setTimer = setTimeout, clearTimer = clearTimeout }) {
    if (!AI?.run || !allowance?.reserve) return { status: 'unavailable', reason: 'Content fact assessment is unavailable; unresolved checks remain unmeasured.' };
    if (!calibrationApproved) return { status: 'unavailable', reason: 'Content fact assessment is awaiting independent calibration; unresolved checks remain unmeasured.' };
    let prepared, input, reserved, reservedAt, reservationId;
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
        reservedAt = now();
        reservationId = crypto.randomUUID();
        const admission = await allowance.reserve({ id: reservationId, costs: { aiNeurons: reserved }, now: reservedAt });
        if (admission?.accepted !== true || admission.duplicate !== false)
            return admission?.reason === 'allowance_exhausted' ? { status: 'budget_exhausted', reason: 'The daily assessment allowance has been reached; unresolved checks remain unmeasured.' } : { status: 'unavailable', reason: 'Assessment budget could not be reserved.' };
    } catch {
        return { status: 'unavailable', reason: 'Content assessment budget could not be reserved.' };
    }
    let timer, timedOut = false, assessed, issued = 0;
    const usages = [];
    try {
        // The AI binding has no cancellation primitive; an expired call retains its reservation.
        const work = async () => {
            issued++;
            const output = await AI.run(CONTENT_FACTS_MODEL, input);
            usages.push(providerNeurons(output, 26668, 204805));
            if (timedOut) throw new Error('Content facts timeout');
            const original = contentOutput(output);
            const facts = decodeContentFacts(prepared, input, original, {requireConditionChecks:true,requireRoleDecisions:true});
            assessed = { status: 'assessed', facts, model: CONTENT_FACTS_MODEL, reservedNeurons: reserved };
            const findings = assessContentFacts(snapshot, extracted, facts).findings;
            const unresolved = Object.entries(findings).filter(([, finding]) => finding.status === 'not_measured').map(([id]) => id);
            const conditional = new Set(['C5.claim-support', ...prepared.payload.category.decisionSupport
                .filter(question => question.applicability === 'conditional').map(question => question.subcheckId)]);
            if (!unresolved.length || !unresolved.every(id => conditional.has(id)) || facts.coverage.productComplete !== true) return assessed;
            const followup = buildConditionInspectionRequest(prepared, original);
            if (!contentFactsFollowupFits(reserved, input, output, followup, reservedAt, now())) {
                assessed.limitation = 'Conditional inspection could not fit within this assessment’s reserved allowance; unresolved checks remain unmeasured.';
                return assessed;
            }
            issued++;
            const conditions = await AI.run(CONTENT_FACTS_MODEL, followup);
            usages.push(providerNeurons(conditions, 26668, 204805));
            if (timedOut) throw new Error('Content facts timeout');
            assessed.facts = decodeConditionInspection(prepared, input, original, contentOutput(conditions));
            return assessed;
        };
        return await Promise.race([work(), new Promise((_, reject) => { timer = setTimer(() => {
            timedOut = true;
            reject(new Error('Content facts timeout'));
        }, TIMEOUT_MS); })]);
    } catch {
        if (assessed) return { ...assessed, limitation: 'Conditional inspection did not finish with supported evidence; unresolved checks remain unmeasured.' };
        return { status: 'unavailable', reason: 'Content fact assessment did not return a supported, grounded result.' };
    } finally {
        if (timer !== undefined) clearTimer(timer);
        if (!timedOut && issued > 0 && usages.length === issued && usages.every(Number.isSafeInteger)) {
            const total = usages.reduce((a, b) => a + b, 0);
            if (Number.isSafeInteger(total)) try { await allowance.settle?.({ id: reservationId, costs: { aiNeurons: total } }); } catch {}
        }
    }
}
