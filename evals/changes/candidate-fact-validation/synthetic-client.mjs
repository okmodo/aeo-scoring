// Manual private synthetic validation. Never invoked by CI.
import { readFile, open, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { decryptEnvelope, filterTelemetry, cpuField, validCpu } from '../ai-real-validation/operator-run.mjs';

export const caseIds = ['running-shoes', 'casual-daypacks', 'personal-flotation-devices', 'handbags', 'basic-tshirts'];
const envelopePath = '/private/tmp/aeo-ai-r7-synthetic-envelope.json';
const keyPath = '/private/tmp/aeo-ai-r7-synthetic-key.pem';
const defaultProof = '/private/tmp/aeo-ai-r7-synthetic-runtime.json';

export function compareFrozen(id, result, expected) {
  if (result?.assessmentResult?.status !== 'assessed' || !expected?.checks) return false;
  if (id === 'basic-tshirts') {
    const score = result.score;
    return score?.status === 'complete' && ['total', 'structure', 'content'].every(key => score.score?.[key] === expected.checks[key]);
  }
  const checks = Object.entries(expected.checks);
  if (checks.length !== 15) return false;
  return checks.every(([key, value]) => {
    const actual = result.grade?.findings?.[key];
    return typeof value === 'number' ? actual?.status === 'measured' && actual.fraction === value : actual?.status === value;
  });
}
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
  const events = [], proofPath = process.argv[2] || defaultProof, state = { cases: [] };
  try {
    const [{ default: WebSocket }, { default: frozen }] = await Promise.all([
      import('../../../backend/node_modules/ws/wrapper.mjs'),
      import('./synthetic-cases.json', { with: { type: 'json' } }),
    ]);
    if (!Array.isArray(frozen) || frozen.length !== caseIds.length || frozen.some((item, i) => item.id !== caseIds[i])) throw new Error('InvalidCases');
    const envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
    const { secret, tailUrl } = decryptEnvelope(envelope, await readFile(keyPath));
    if (typeof secret !== 'string' || typeof tailUrl !== 'string' || typeof envelope.endpoint !== 'string') throw new Error('InvalidEnvelope');
    const endpoint = new URL(envelope.endpoint);
    if (endpoint.pathname !== '/validate' || endpoint.search || endpoint.hash) throw new Error('InvalidEndpoint');
    let tailBytes = 0;
    socket = new WebSocket(tailUrl, 'trace-v1', { maxPayload: 512 * 1024 });
    socket.on('error', () => {});
    socket.on('message', data => {
      tailBytes += data.length;
      if (tailBytes > 512 * 1024 || events.length >= 64) return;
      try { events.push(filterTelemetry(JSON.parse(data.toString()))); } catch { /* Ignore malformed events. */ }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SocketTimeout')), 8000);
      socket.once('open', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('SocketError')); });
    });
    socket.send(JSON.stringify({ debug: true }));
    const deadline = Date.now() + 8000;
    const control = await fetch(new URL('/control', endpoint), { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (control.status !== 401 && control.status !== 404) throw new Error('ControlUnexpectedStatus');
    state.controlTelemetry = await waitForEvent(events, event => event.paths.includes('/control') && validCpu(event), Math.max(0, deadline - Date.now()));
    await writeProof(proofPath, state);
    for (const [index, id] of caseIds.entries()) {
      const url = new URL(`/validate/${id}`, endpoint), before = events.length;
      const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, redirect: 'manual', signal: AbortSignal.timeout(35000) });
      const result = await response.json();
      const record = { id, status: response.status, result };
      state.cases.push(record);
      await writeProof(proofPath, state);
      if (response.status !== 200 || result.caseId !== id || !compareFrozen(id, result, frozen[index].expected)) throw new Error('CaseMismatch');
      record.telemetry = await waitForEvent(events, event => events.indexOf(event) >= before && event.paths.includes(url.pathname) && validCpu(event), 5000).catch(() => null);
      record.cpuGatePassed = record.telemetry !== null && validCpu(record.telemetry, 1000);
      await writeProof(proofPath, state);
      if (!record.cpuGatePassed) throw new Error('CpuGateFailed');
      console.log(JSON.stringify({ id, status: response.status, cpu: cpuField(record.telemetry), modelCalls: result.modelCalls?.filter(call => call.invoked).length ?? 0, progress: `${index + 1}/${caseIds.length}` }));
    }
  } catch (error) {
    const known = new Set(['InvalidCases', 'InvalidEnvelope', 'InvalidEndpoint', 'SocketTimeout', 'SocketError', 'ControlUnexpectedStatus', 'TelemetryTimeout', 'CaseMismatch', 'CpuGateFailed']);
    const name = typeof error?.name === 'string' && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error';
    const code = known.has(error?.message) ? error.message : (typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : undefined);
    state.failure = { error: name, ...(code ? { code } : {}) };
    state.telemetry = events;
    await writeProof(proofPath, state).catch(() => {});
    console.error(JSON.stringify(state.failure));
    process.exitCode = 1;
  } finally {
    socket?.close();
    await Promise.allSettled([unlink(keyPath), unlink(envelopePath)]);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
