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
const defaultDiagnostic = detail => console.error('terra_provider_failure', detail);
function classifyFetchError(error) {
  if (!(error instanceof TypeError)) return 'unknown';
  const message = typeof error.message === 'string' ? error.message : '';
  if (/illegal invocation|incompatible receiver/i.test(message)) return 'illegal_invocation';
  if (/invalid (?:header|character)|headers? (?:name|value)/i.test(message)) return 'invalid_header';
  if (/i\/o context|different (?:request|context)|outside.*request/i.test(message)) return 'io_context';
  if (/fetch failed|network|connection|socket/i.test(message)) return 'network';
  return 'unknown';
}
export function createTerraByokProvider(env, { fetch: fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : globalThis.fetch, onDiagnostic = defaultDiagnostic } = {}) {
  const diagnostic = detail => { try { if (typeof onDiagnostic === 'function') onDiagnostic(detail); } catch {} };
  return { async run(model, input, { signal } = {}) {
    if (model !== config.model || !input || typeof input !== 'object' || Array.isArray(input) || typeof env?.AUDIT_AI_GATEWAY_TOKEN !== 'string' || !env.AUDIT_AI_GATEWAY_TOKEN.trim() || typeof fetchImpl !== 'function') { diagnostic({phase:'validation'}); throw failure(); }
    if (input.model != null && input.model !== config.model) { diagnostic({phase:'validation'}); throw failure(); }
    const { messages, max_tokens } = input;
    if (!Array.isArray(messages) || !Number.isSafeInteger(max_tokens) || max_tokens < 1 || max_tokens > Math.max(...Object.values(config.stageCaps))) { diagnostic({phase:'validation'}); throw failure(); }
    const params = { input: messages, max_output_tokens: max_tokens, reasoning: { effort: config.reasoningEffort }, text: { format: { type: config.responseFormat } }, stream: config.stream };
    const body = JSON.stringify({ model: config.model, input: params });
    if (encoder.encode(body).length > config.requestMaxBytes) throw new Error('request_limit');
    let response;
    try { response = await fetchImpl(config.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${env.AUDIT_AI_GATEWAY_TOKEN.trim()}`, 'Content-Type': 'application/json', 'cf-aig-gateway-id': config.gatewayId, 'cf-aig-no-wholesale': 'true', 'cf-aig-max-attempts': '1' }, body, signal, redirect: 'manual' }); } catch (error) { diagnostic(signal?.aborted ? {phase:'abort'} : {phase:'fetch',class:classifyFetchError(error)}); throw failure(); }
    if (response?.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch {}
      diagnostic({phase:'http',status:response.status}); throw failure();
    }
    if (!response?.ok) {
      const detail = {phase:'http'};
      if (Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599) detail.status = response.status;
      const retry = response?.headers?.get?.('retry-after');
      if (typeof retry === 'string' && /^\d{1,5}$/.test(retry) && Number(retry) <= 86400) detail.retryAfter = Number(retry);
      try {
        const envelope = await readBounded(response);
        const codes = Array.isArray(envelope?.errors) ? envelope.errors.map(error => error?.code).filter(code => Number.isSafeInteger(code) && code >= 0 && code <= 999999).slice(0,5) : [];
        if (codes.length) detail.codes = codes;
      } catch {}
      diagnostic(detail); throw failure();
    }
    let envelope;
    try { envelope = await readBounded(response); } catch { diagnostic({phase:'read'}); throw failure(); }
    const result = envelope?.result;
    if (envelope?.success !== true || (Array.isArray(envelope.errors) && envelope.errors.length) || !result || result.object !== 'response' || result.status !== 'completed' || result.error !== null || result.incomplete_details !== null || !Array.isArray(result.output) || !result.output.length) { diagnostic({phase:'envelope'}); throw failure(); }
    const texts = [];
    for (const item of result.output) {
      if (item?.type === 'reasoning' && Array.isArray(item.summary) && (item.status == null || item.status === 'completed')) continue;
      if (item?.type !== 'message' || item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content) || !item.content.length) { diagnostic({phase:'output'}); throw failure(); }
      for (const part of item.content) {
        if (part?.type !== 'output_text' || typeof part.text !== 'string') { diagnostic({phase:'output'}); throw failure(); }
        texts.push(part.text);
      }
    }
    if (!texts.length) { diagnostic({phase:'output'}); throw failure(); }
    const content = texts.join('');
    let parsed; try { parsed = JSON.parse(content); } catch { diagnostic({phase:'parse'}); throw failure(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { diagnostic({phase:'parse'}); throw failure(); }
    return { response: content };
  } };
}
