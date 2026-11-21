import config from '../config/granite-model.json' with { type: 'json' };
import { providerNeurons } from './allowance-reconciliation.mjs';

export const GRANITE_MODEL_CONFIG = Object.freeze(config);
const encoder = new TextEncoder();
const failure = () => new Error('model_provider_failure');
const badOutput = () => new Error('model_output_invalid');
export function serializeGraniteRequest(input) {
  const [system, ...rest] = input.messages;
  const messages = system?.role === 'system'
    ? [{ ...system, content: system.content + ' Return one JSON object. Escape double quotes inside strings. When evidence is requested, use an array of objects like [{"sourceId":"s1","quote":"exact text"}].' }, ...rest]
    : input.messages;
  return JSON.stringify({ messages, max_tokens: config.maxTokens, temperature: config.temperature, stream: false });
}
async function readBounded(response) {
  if (!response.body?.getReader) throw failure();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw failure();
      if ((size += value.byteLength) > config.outputMaxBytes) throw new Error('output_limit');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) { try { await reader.cancel(); } catch {} throw error; }
}
const defaultDiagnostic = detail => console.error('granite_provider_failure', detail);
export function createGraniteProvider(env, { fetch: fetchImpl = globalThis.fetch?.bind(globalThis), allowance, now = Date.now, onDiagnostic = defaultDiagnostic } = {}) {
  const diagnostic = detail => { try { if (typeof onDiagnostic === 'function') onDiagnostic(detail); } catch {} };
  return { async run(model, input, { signal } = {}) {
    if (model !== config.model || !input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.messages) || !input.messages.length || (input.model != null && input.model !== model) || typeof env?.AUDIT_AI_GATEWAY_TOKEN !== 'string' || !env.AUDIT_AI_GATEWAY_TOKEN.trim() || typeof fetchImpl !== 'function' || typeof allowance?.reserve !== 'function' || typeof allowance?.settle !== 'function') { diagnostic({ phase: 'validation' }); throw failure(); }
    let body;
    try { body = serializeGraniteRequest(input); } catch { diagnostic({ phase: 'validation' }); throw failure(); }
    const bytes = encoder.encode(body).byteLength;
    if (bytes > config.requestMaxBytes) throw new Error('request_limit');
    // A byte per input token plus protocol overhead bounds typical tokenization.
    const reserved = Math.ceil(((bytes + 2048) * config.inputNeuronsPerMillion + config.maxTokens * config.outputNeuronsPerMillion) / 1_000_000) + 64;
    const id = crypto.randomUUID();
    if (signal?.aborted) throw signal.reason;
    const readToken = env.AUDIT_AI_GATEWAY_READ_TOKEN ?? env.AUDIT_AI_GATEWAY_TOKEN;
    if (typeof readToken !== 'string' || !readToken.trim()) throw failure();
    // Unified billing uses prepaid credits outside the account's neuron allocation.
    try {
      const metadata = await fetchImpl(config.gatewayEndpoint, {
        method: 'GET', headers: { Authorization: `Bearer ${readToken.trim()}` }, signal, redirect: 'manual',
      });
      if (!metadata?.ok) {
        await metadata?.body?.cancel().catch(() => {});
        throw failure();
      }
      const gateway = await readBounded(metadata);
      if (gateway?.success !== true || gateway.result?.id !== config.gatewayId || gateway.result.workers_ai_billing_mode !== 'postpaid') throw failure();
    } catch { diagnostic({ phase: 'billing' }); throw failure(); }
    if (signal?.aborted) throw signal.reason;
    const admission = await allowance.reserve({ id, costs: { aiNeurons: reserved }, now: now() }).catch(() => null);
    if (admission?.accepted !== true || admission.duplicate !== false) {
      diagnostic({ phase: 'reserve' });
      throw new Error('admission_failed');
    }
    if (signal?.aborted) {
      await allowance.settle({ id, costs: { aiNeurons: 0 }, now: now() }).catch(() => {});
      throw signal.reason;
    }
    let response;
    try {
      response = await fetchImpl(config.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${env.AUDIT_AI_GATEWAY_TOKEN.trim()}`, 'Content-Type': 'application/json', 'cf-aig-gateway-id': config.gatewayId, 'cf-aig-max-attempts': '1', 'cf-aig-no-wholesale': 'true' }, body, signal, redirect: 'manual' });
    } catch { diagnostic({ phase: signal?.aborted ? 'abort' : 'fetch' }); throw failure(); }
    if (!response?.ok || response.status >= 300) { try { await response?.body?.cancel(); } catch {} diagnostic({ phase: 'http', ...(Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? { status: response.status } : {}) }); throw failure(); }
    let envelope;
    try { envelope = await readBounded(response); } catch (error) { diagnostic({ phase: 'read' }); throw error?.message === 'output_limit' ? error : failure(); }
    if (signal?.aborted) throw signal.reason;
    const result = envelope?.result;
    // Meter root provider usage even when generated content or envelope is invalid.
    const usage = providerNeurons(result, config.inputNeuronsPerMillion, config.outputNeuronsPerMillion);
    if (usage !== null) {
      let settlement;
      try { settlement = await allowance.settle({ id, costs: { aiNeurons: usage }, now: now() }); } catch { diagnostic({ phase: 'settle' }); throw failure(); }
      if (settlement?.accepted !== true || settlement.overrun) { diagnostic({ phase: settlement?.overrun ? 'overrun' : 'settle' }); throw failure(); }
    }
    if (envelope?.success !== true || (Array.isArray(envelope.errors) && envelope.errors.length) || !result || typeof result !== 'object' || Array.isArray(result)) { diagnostic({ phase: 'envelope' }); throw failure(); }
    let content;
    if (typeof result.response === 'string' && result.choices === undefined) content = result.response;
    else if (Array.isArray(result.choices) && result.choices.length === 1 && result.choices[0]?.finish_reason === 'stop' && result.choices[0]?.message?.role === 'assistant' && typeof result.choices[0]?.message?.content === 'string') content = result.choices[0].message.content;
    else { diagnostic({ phase: 'output' }); throw badOutput(); }
    if (result.finish_reason != null && result.finish_reason !== 'stop') { diagnostic({ phase: 'output' }); throw badOutput(); }
    let parsed;
    try { parsed = JSON.parse(content); } catch { diagnostic({ phase: 'parse' }); throw badOutput(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw badOutput();
    return { response: parsed, ...(result.usage ? { usage: result.usage } : {}) };
  } };
}
