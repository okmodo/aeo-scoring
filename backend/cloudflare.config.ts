import { bindings, defineConfig, triggers } from 'cf/config';
import * as entrypoint from './preview-worker.mjs' with { type: 'cf-worker' };

const databaseId = process.env.AEO_AUDIT_PREVIEW_DB_ID;
if (!databaseId || !/^[0-9a-f-]{36}$/.test(databaseId)) {
  throw new Error('Set AEO_AUDIT_PREVIEW_DB_ID to the dedicated audit preview D1 database ID.');
}

export default defineConfig({
  worker: {
    name: 'aeo-audit-live-20261105',
    entrypoint,
    compatibilityDate: '2026-11-05',
    workersDev: true,
    previewUrls: false,
    env: {
      AUDIT_DB: bindings.d1({ id: databaseId }),
      AUDIT_RATE_SECRET: bindings.secret(),
    },
    triggers: [triggers.scheduled({ schedule: '0 * * * *' })],
    observability: {
      enabled: true,
      headSamplingRate: 0.01,
      logs: { invocationLogs: false },
      traces: { enabled: true, headSamplingRate: 0.01 },
    },
  },
});
