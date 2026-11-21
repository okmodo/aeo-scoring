import { AI_MODEL_CONFIG as config } from './ai-model-config.mjs';

const encoder = new TextEncoder();
const failure = () => new Error('model_provider_failure');
async function readBounded(response) {
  if (!response.body?.getReader) throw failure();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || (size += value.byteLength) > config.outputMaxBytes) throw failure();
      chunks.push(value);
    }
  } catch { try { await reader.cancel(); } catch {} throw failure(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { throw failure(); }
}
export function createTerraByokProvider(env, { fetch: fetchImpl = globalThis.fetch } = {}) {
  return { async run(model, input, { signal } = {}) {
    if (model !== config.model || !input || typeof input !== 'object' || Array.isArray(input) || typeof env?.AUDIT_AI_GATEWAY_TOKEN !== 'string' || !env.AUDIT_AI_GATEWAY_TOKEN.trim() || typeof fetchImpl !== 'function') throw failure();
    if (input.model != null && input.model !== config.model) throw failure();
    const { messages, max_tokens } = input;
    if (!Array.isArray(messages) || !Number.isSafeInteger(max_tokens) || max_tokens < 1 || max_tokens > Math.max(...Object.values(config.stageCaps))) throw failure();
    const params = { messages, max_completion_tokens: max_tokens, reasoning_effort: config.reasoningEffort, response_format: { type: config.responseFormat }, stream: config.stream };
    const body = JSON.stringify({ model: config.model, input: params });
    if (encoder.encode(body).length > config.requestMaxBytes) throw new Error('request_limit');
    let response;
    try { response = await fetchImpl(config.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${env.AUDIT_AI_GATEWAY_TOKEN}`, 'Content-Type': 'application/json', 'cf-aig-no-wholesale': 'true', 'cf-aig-max-attempts': '1' }, body, signal, redirect: 'error' }); } catch { throw failure(); }
    if (!response?.ok) throw failure();
    const envelope = await readBounded(response);
    if (envelope?.success !== true || (Array.isArray(envelope.errors) && envelope.errors.length) || !envelope.result || typeof envelope.result !== 'object') throw failure();
    const choice = envelope.result.choices?.[0];
    if (!choice || choice.finish_reason !== 'stop' || choice.message?.refusal || typeof choice.message?.content !== 'string') throw failure();
    let parsed; try { parsed = JSON.parse(choice.message.content); } catch { throw failure(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw failure();
    return { response: choice.message.content };
  } };
}
