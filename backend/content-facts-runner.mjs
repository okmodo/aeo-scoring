import { buildSemanticRequest } from './semantic-assessment.mjs';
import { inspectProductSchema } from './structure-assessment.mjs';
import { buildContentFactsRequest, decodeContentFacts, buildConditionInspectionRequest, decodeConditionInspection, CONTENT_FACTS_MODEL } from './content-facts.mjs';
import { assessContentFacts } from './fact-grading.mjs';
import { providerNeurons } from './allowance-reconciliation.mjs';
import { assessWithCategoryProfile, restoreCategoryProfile } from './category-profile.mjs';

// Enable only after independent live calibration and an explicit decision.
export const CONTENT_FACTS_CALIBRATION_APPROVED = false;
export const CONTENT_FACTS_RELEASE_ID = 'content-facts-2026-11-12-r15';
const MAX_INPUT_BYTES = 60 * 1024;
const MAX_OUTPUT_TOKENS = 2048;
const TIMEOUT_MS = 12_000;
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
export async function assessWithContentFacts({ AI, allowance, now = Date.now, snapshot, extracted, report, calibrationApproved = CONTENT_FACTS_CALIBRATION_APPROVED, setTimer = setTimeout, clearTimer = clearTimeout, deadlineAt, onProfile }) {
    const startWall = Date.now();
    const budget = Number.isFinite(deadlineAt) ? Math.max(0, Math.min(25_000, deadlineAt - now())) : 25_000;
    const remaining = () => Math.max(0, budget - (Date.now() - startWall));
    if (!AI?.run || !allowance?.reserve) return { status: 'unavailable', reason: 'Content fact assessment is unavailable; unresolved checks remain unmeasured.' };
    if (!calibrationApproved) return { status: 'unavailable', reason: 'Content fact assessment is awaiting independent calibration; unresolved checks remain unmeasured.' };
    let prepared, input, reserved, reservedAt, reservationId;
    try {
        prepared = buildSemanticRequest(snapshot, extracted, report, { product: inspectProductSchema(snapshot, extracted).product });
        if (prepared.unsafeInstructions || prepared.payload.coverage.unsafeInstructions) return { status: 'unsafe_content', reason: 'Instruction-like product content prevents a reliable assessment; unresolved checks remain unmeasured.' };

    } catch {
        return { status: 'unavailable', reason: 'Content fact assessment could not prepare a safe bounded request.' };
    }
    const categoryResult = await assessWithCategoryProfile({ AI, allowance, now, prepared, remaining });
    if (categoryResult.status !== 'assessed') return { ...categoryResult, reason: categoryResult.status === 'ambiguous' ? 'The primary product category could not be established.' : 'The category profile could not be established; unresolved checks remain unmeasured.', stages: [{stage:'category',status:'failed',code:`${categoryResult.stage}_${categoryResult.reason}`},{stage:'content',status:'skipped',code:'category_unavailable'}] };
    const categoryProfile = categoryResult.profile;
    if (onProfile) try { await onProfile(categoryProfile); } catch { return {status:'unavailable',reason:'The category profile could not be retained.',stages:[{stage:'category',status:'completed',code:'profile_validated'},{stage:'content',status:'failed',code:'profile_persistence_failed'}]}; }
    prepared.payload.category = categoryProfile;
    prepared.payload.context.category = categoryProfile.id;
    try { input = buildContentFactsRequest(prepared); reserved = contentFactsReservation(input); } catch { return { status: 'unavailable', stage: 'facts', reason: 'preparation_failed', categoryProfile, stages: [{stage:'category',status:'completed',code:'profile_validated'},{stage:'content',status:'failed',code:'preparation_failed'}] }; }
    if (remaining() <= 0) return {status:'unavailable',reason:'Assessment time expired.',categoryProfile,stages:[{stage:'category',status:'completed',code:'profile_validated'},{stage:'content',status:'failed',code:'deadline_exceeded'}]};
    try {
        reservedAt = now();
        reservationId = crypto.randomUUID();
        const admission = await allowance.reserve({ id: reservationId, costs: { aiNeurons: reserved }, now: reservedAt });
        if (admission?.accepted !== true || admission.duplicate !== false)
            return {status: admission?.reason === 'allowance_exhausted' ? 'budget_exhausted' : 'unavailable', reason: 'Assessment budget could not be reserved.', categoryProfile, stages:[{stage:'category',status:'completed',code:'profile_validated'},{stage:'content',status:'failed',code:'admission_failed'}]};
    } catch {
        return { status: 'unavailable', reason: 'Content assessment budget could not be reserved.', categoryProfile, stages:[{stage:'category',status:'completed',code:'profile_validated'},{stage:'content',status:'failed',code:'admission_failed'}] };
    }
    let timer, timedOut = false, assessed, issued = 0;
    const usages = [];
    try {
        // The AI binding has no cancellation primitive; an expired call retains its reservation.
        if (remaining() <= 0) throw new Error('deadline');
        const work = async () => {
            issued++;
            const output = await AI.run(CONTENT_FACTS_MODEL, input);
            usages.push(providerNeurons(output, 26668, 204805));
            if (timedOut) throw new Error('Content facts timeout');
            const original = contentOutput(output);
            const facts = decodeContentFacts(prepared, input, original, {requireConditionChecks:true,requireRoleSlots:true});
            const replayArtifact = await makeReplayArtifact(snapshot, extracted, report, categoryProfile, original);
            if (timedOut) throw new Error('Content facts timeout');
            assessed = { status: 'assessed', facts, categoryProfile, replayArtifact, stages: [{stage:'category',status:'completed',code:'profile_validated'},{stage:'content',status:'completed',code:'facts_validated'}], model: CONTENT_FACTS_MODEL, reservedNeurons: reserved };
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
            if (remaining() <= 0) return assessed;
            issued++;
            const conditions = await AI.run(CONTENT_FACTS_MODEL, followup);
            usages.push(providerNeurons(conditions, 26668, 204805));
            if (timedOut) throw new Error('Content facts timeout');
            const conditionOutput = contentOutput(conditions);
            const completedFacts = decodeConditionInspection(prepared, input, original, conditionOutput);
            const completedArtifact = await makeReplayArtifact(snapshot, extracted, report, categoryProfile, original, conditionOutput);
            if (timedOut) throw new Error('Content facts timeout');
            assessed.facts = completedFacts;
            assessed.replayArtifact = completedArtifact;
            return assessed;
        };
        return await Promise.race([work(), new Promise((_, reject) => { timer = setTimer(() => {
            timedOut = true;
            reject(new Error('Content facts timeout'));
        }, Math.min(TIMEOUT_MS, remaining())); })]);
    } catch {
        if (assessed) return { ...assessed, limitation: 'Conditional inspection did not finish with supported evidence; unresolved checks remain unmeasured.' };
        return { status: 'unavailable', reason: 'Content fact assessment did not return a supported, grounded result.', categoryProfile, stages:[{stage:'category',status:'completed',code:'profile_validated'},{stage:'content',status:'failed',code: usages.length ? 'validation_failed' : 'model_failed'}] };
    } finally {
        if (timer !== undefined) clearTimer(timer);
        if (!timedOut && issued > 0 && usages.length === issued && usages.every(Number.isSafeInteger)) {
            const total = usages.reduce((a, b) => a + b, 0);
            if (Number.isSafeInteger(total)) try { await allowance.settle?.({ id: reservationId, costs: { aiNeurons: total } }); } catch {}
        }
    }
}

const MAX_REPLAY_BYTES = 256 * 1024;
async function sourceDigest(snapshot, extracted, report) {
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
    const encoded = new TextEncoder().encode(JSON.stringify(canonical({snapshot,extracted,report})));
    if (encoded.length > 3 * 1024 * 1024) throw new Error('Replay source exceeds budget');
    const digest = await crypto.subtle.digest('SHA-256',encoded);
    return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
async function makeReplayArtifact(snapshot, extracted, report, categoryProfile, originalOutput, conditionOutput) {
    const artifact = {version:'1',sourceDigest:await sourceDigest(snapshot,extracted,report),categoryProfile,originalOutput,...(conditionOutput === undefined ? {} : {conditionOutput})};
    const serialized=JSON.stringify(artifact);
    if (!serialized || new TextEncoder().encode(serialized).length > MAX_REPLAY_BYTES) throw new Error('Replay artifact exceeds budget');
    return JSON.parse(serialized);
}
/** Reconstruct validated facts from retained inputs without inference or allowance work. */
export async function replayContentAssessment({snapshot,extracted,report,artifact}) {
    if (!artifact || artifact.version !== '1' || Object.keys(artifact).some(k=>!['version','sourceDigest','categoryProfile','originalOutput','conditionOutput'].includes(k)) || !Object.hasOwn(artifact,'originalOutput') || new TextEncoder().encode(JSON.stringify(artifact)).length > MAX_REPLAY_BYTES) throw new Error('Invalid replay artifact');
    if (typeof artifact.sourceDigest !== 'string' || artifact.sourceDigest !== await sourceDigest(snapshot,extracted,report)) throw new Error('Replay source mismatch');
    const prepared=buildSemanticRequest(snapshot,extracted,report,{product:inspectProductSchema(snapshot,extracted).product});
    if (prepared.unsafeInstructions || prepared.payload.coverage.unsafeInstructions) throw new Error('Unsafe retained source');
    const categoryProfile=restoreCategoryProfile(prepared,artifact.categoryProfile);
    prepared.payload.category=categoryProfile;
    prepared.payload.context.category=categoryProfile.id;
    const input=buildContentFactsRequest(prepared);
    const original=decodeContentFacts(prepared,input,artifact.originalOutput,{requireConditionChecks:true,requireRoleSlots:true});
    const facts=Object.hasOwn(artifact,'conditionOutput') ? decodeConditionInspection(prepared,input,artifact.originalOutput,artifact.conditionOutput) : original;
    return {status:'assessed',categoryProfile,facts};
}
