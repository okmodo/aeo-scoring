import { workerData, parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createAllowanceGuard } from './allowance-store.mjs';

const { path, barrier, id, evidence, allocations, costs, now } = workerData;
const sqlite = new DatabaseSync(path);
sqlite.exec('PRAGMA busy_timeout = 30000');
const db = { prepare(sql) { return { bind(...args) {
  const stmt = sqlite.prepare(sql);
  return { run: async () => stmt.run(...args), first: async () => stmt.get(...args) ?? null };
} }; } };
const guard = createAllowanceGuard(db, { accountId: 'account', evidence, allocations });
const signal = new Int32Array(barrier);
parentPort.postMessage({ ready: true });
Atomics.wait(signal, 0, 0);
try {
  parentPort.postMessage({ result: await guard.reserve({ id: String(id), costs, now }) });
} catch (error) {
  parentPort.postMessage({ error: error.message });
} finally {
  sqlite.close();
}
