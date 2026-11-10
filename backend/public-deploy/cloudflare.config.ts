import { bindings, defineConfig, triggers } from 'cf/config';
import * as entrypoint from '../public-worker.mjs' with { type: 'cf-worker' };
import { MAX_INVOCATION_CPU_MS } from '../allowance-policy.mjs';

const databaseId = process.env.AEO_PUBLIC_AUDIT_DB_ID;
if (!databaseId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(databaseId)) {
  throw new Error('Set AEO_PUBLIC_AUDIT_DB_ID to the dedicated public audit D1 database ID.');
}

export default defineConfig({
  worker: {
    name: 'aeo-audit-public-20261105',
    limits: { cpuMs: MAX_INVOCATION_CPU_MS },
    entrypoint,
    compatibilityDate: '2026-11-05',
    compatibilityFlags: ['global_fetch_strictly_public', 'cache_option_enabled'],
    workersDev: true,
    previewUrls: false,
    env: {
      AUDIT_DB: bindings.d1({ id: databaseId }),
      AUDIT_RATE_SECRET: bindings.secret(),
    },
    triggers: [triggers.scheduled({ schedule: '0 * * * *' })],
    observability: {
      enabled: false,
      logs: { enabled: false, invocationLogs: false },
      traces: { enabled: false },
    },
  },
});
