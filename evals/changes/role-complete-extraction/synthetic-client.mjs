// Manual private synthetic validation. Never invoked by CI.
import { readFile, open, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { decryptEnvelope } from '../ai-real-validation/operator-run.mjs';

// Persist only recognized primary CPU fields and request pathnames.
export function filterTelemetry(event) {
  const cpu = [event?.cpuTime, event?.cpuTimeMs, event?.$workers?.cpuTimeMs].find(value => typeof value === 'number' && Number.isFinite(value));
  let path;
  try { path = new URL(event?.event?.request?.url).pathname; } catch { /* No usable request path. */ }
  return { ...(cpu === undefined ? {} : { cpuMs: cpu }), ...(path ? { path } : {}) };
}
export function validCpu(event, maximum = Infinity) { return typeof event?.cpuMs === 'number' && Number.isFinite(event.cpuMs) && event.cpuMs >= 0 && event.cpuMs <= maximum; }

export const caseIds = ['running-shoes', 'casual-daypacks', 'personal-flotation-devices', 'handbags', 'basic-tshirts'];
const envelopePath = '/private/tmp/aeo-ai-r8-synthetic-envelope.json';
const keyPath = '/private/tmp/aeo-ai-r8-synthetic-key.pem';
const defaultProof = '/private/tmp/aeo-ai-r8-synthetic-runtime.json';

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
export async function captureResponse(response, id, persist) {
  const record = { id, status: response.status };
  await persist(record);
  try { record.result = await response.json(); } catch { throw new Error('InvalidResponseJSON'); }
  await persist(record);
  return record;
}
export async function captureCase(response, id, persist, telemetry) {
  let parseError;
  const record = await captureResponse(response, id, persist).catch(error => { parseError = error; return { id, status: response.status }; });
  record.telemetry = await telemetry().catch(() => null);
  record.cpuGatePassed = record.telemetry !== null && validCpu(record.telemetry, 1000);
  await persist(record);
  if (!record.cpuGatePassed) throw new Error('CpuGateFailed');
  if (parseError) throw parseError;
  return record;
}
export function resultDigest(result) {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}
export async function requireReview(id, digest, input = process.stdin, timeout = 30 * 60 * 1000) {
  if (!/^[a-z-]+$/.test(id) || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('InvalidReviewGate');
  const reader = createInterface({ input, terminal: false });
  try {
    const line = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ReviewTimeout')), timeout);
      reader.once('line', value => { clearTimeout(timer); resolve(value); });
      reader.once('close', () => { clearTimeout(timer); reject(new Error('ReviewEOF')); });
    });
    if (line !== `REVIEW_PASS ${id} ${digest}`) throw new Error('ReviewRejected');
  } finally { reader.close(); }
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
    state.controlTelemetry = await waitForEvent(events, event => event.path === '/control' && validCpu(event), Math.max(0, deadline - Date.now()));
    await writeProof(proofPath, state);
    for (const [index, id] of caseIds.entries()) {
      const url = new URL(`/validate/${id}`, endpoint), before = events.length;
      const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, redirect: 'manual', signal: AbortSignal.timeout(35000) });
      const record = await captureCase(response, id, async record => {
        const existing = state.cases.findIndex(item => item.id === id);
        if (existing < 0) state.cases.push(record); else state.cases[existing] = record;
        await writeProof(proofPath, state);
      }, () => waitForEvent(events, event => events.indexOf(event) >= before && event.path === url.pathname && validCpu(event), 5000));
      const result = record.result;
      if (response.status !== 200 || result?.caseId !== id || !compareFrozen(id, result, frozen[index].expected)) throw new Error('CaseMismatch');
      const digest = resultDigest(result);
      console.log(JSON.stringify({ awaitingReview: id, resultSha256: digest }));
      await requireReview(id, digest);
      record.review = { decision: 'pass', resultSha256: digest };
      await writeProof(proofPath, state);
    }
  } catch (error) {
    const known = new Set(['InvalidCases', 'InvalidEnvelope', 'InvalidEndpoint', 'SocketTimeout', 'SocketError', 'ControlUnexpectedStatus', 'TelemetryTimeout', 'CaseMismatch', 'CpuGateFailed', 'InvalidResponseJSON', 'InvalidReviewGate', 'ReviewTimeout', 'ReviewEOF', 'ReviewRejected']);
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
