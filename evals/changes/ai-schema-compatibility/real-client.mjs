// Manual private release validation client. This script is never run by CI.
import { decryptEnvelope } from '../ai-real-validation/operator-run.mjs';
import { filterTelemetry, validCpu } from './synthetic-client.mjs';
import { readFile, open, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const envelopePath = '/private/tmp/aeo-ai-r10-real-envelope.json';
const keyPath = '/private/tmp/aeo-ai-r10-real-key.pem';
const defaultProof = '/private/tmp/aeo-ai-r10-real-runtime.json';
function waitForEvent(events, predicate, timeout) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const check = () => {
      const match = events.find(predicate);
      if (match) return resolve(match);
      if (Date.now() >= deadline) return reject(new Error('TelemetryTimeout'));
      setTimeout(check, 50);
    };
    check();
  });
}
async function writeProof(path, value) {
  const file = await open(path, 'w', 0o600);
  try { await file.chmod(0o600); await file.writeFile(JSON.stringify(value, null, 2)); }
  finally { await file.close(); }
}
async function main() {
  let socket;
  const events = [], proofPath = process.argv[2] || defaultProof;
  const state = {};
  try {
    const { default: WebSocket } = await import('../../../backend/node_modules/ws/wrapper.mjs');
    const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
    const privateKey = await readFile(keyPath);
    const { secret, tailUrl } = decryptEnvelope(envelope, privateKey);
    if (typeof secret !== 'string' || typeof tailUrl !== 'string' || typeof envelope.endpoint !== 'string') throw new Error('InvalidEnvelope');
    const endpoint = new URL(envelope.endpoint);
    const control = new URL('/control', endpoint);
    let tailBytes = 0;
    socket = new WebSocket(tailUrl, 'trace-v1', { maxPayload: 512 * 1024 });
    socket.on('error', () => {}); // Keep errors handled through close.
    socket.on('message', data => {
      tailBytes += data.length;
      if (tailBytes > 512 * 1024 || events.length >= 32) return;
      try { events.push(filterTelemetry(JSON.parse(data.toString()))); } catch { /* Ignore malformed events. */ }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SocketTimeout')), 8000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('SocketError')); });
    });
    socket.send(JSON.stringify({ debug: true }));
    const controlDeadline = Date.now() + 8000;
    const controlResponse = await fetch(control, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (controlResponse.status !== 401 && controlResponse.status !== 404) throw new Error('ControlUnexpectedStatus');
    const controlEvent = await waitForEvent(events, event => event.path === '/control' && validCpu(event), Math.max(0, controlDeadline - Date.now()));
    state.controlTelemetry = controlEvent;
    const before = events.length;
    const body = JSON.stringify({ url: 'https://kokatat.com/naiad-pfd-lvhnai' });
    const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
    const response = await fetch(endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(45000) });
    state.status = response.status;
    await writeProof(proofPath, state);
    let proof, parseError;
    try { proof = await response.json(); state.proof = proof; } catch { parseError = new Error('InvalidResponseJSON'); }
    await writeProof(proofPath, state);
    // Wait before the duplicate POST so the matching event can only be the primary request.
    const auditEvent = await waitForEvent(events, event => events.indexOf(event) >= before && event.path === endpoint.pathname && validCpu(event), 5000).catch(() => null);
    Object.assign(state, { auditTelemetry: auditEvent, cpuGatePassed: auditEvent !== null && validCpu(auditEvent, 1000) });
    await writeProof(proofPath, state);
    if (!state.cpuGatePassed) throw new Error(auditEvent ? 'CpuLimitExceeded' : 'PrimaryTelemetryMissing');
    if (parseError) throw parseError;
    if (!response.ok) throw new Error('ResponseFailed');
    const repeat = await fetch(endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(8000) });
    state.repeatStatus = repeat.status;
    await writeProof(proofPath, state);
    console.log(JSON.stringify({ status: response.status, cache: proof.validation?.cache ?? null, modelCalls: proof.validation?.modelCalls?.filter(call => call.invoked).length ?? 0, repeatStatus: repeat.status, controlCpu: controlEvent.cpuMs, auditCpu: auditEvent.cpuMs }));
    if (repeat.status !== 429) process.exitCode = 1;
  } catch (error) {
    const name = typeof error?.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
    const known = new Set(['TelemetryTimeout', 'SocketTimeout', 'SocketError', 'ControlUnexpectedStatus', 'InvalidEnvelope', 'InvalidKey', 'InvalidCiphertext', 'CpuLimitExceeded', 'PrimaryTelemetryMissing', 'InvalidResponseJSON', 'ResponseFailed']);
    const code = known.has(error?.message) ? error.message : (typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : undefined);
    await writeProof(proofPath, { ...state, failure: { error: name, ...(code ? { code } : {}) }, telemetry: events }).catch(() => {});
    console.error(JSON.stringify({ error: name, ...(code ? { code } : {}) }));
    process.exitCode = 1;
  } finally {
    socket?.close();
    await Promise.allSettled([unlink(keyPath), unlink(envelopePath)]);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
