import { bindings, defineConfig } from 'cf/config';
import * as entrypoint from './worker.mjs' with { type: 'cf-worker' };
export default defineConfig({
  worker: {
    name: 'aeo-stream-rollout-fixtures-20261108',
    entrypoint,
    compatibilityDate: '2026-11-05',
    workersDev: true,
    previewUrls: false,
    env: { FIXTURE_EXPIRES_AT: bindings.secret() },
    observability: { enabled: true, logs: { invocationLogs: false } },
  },
});
