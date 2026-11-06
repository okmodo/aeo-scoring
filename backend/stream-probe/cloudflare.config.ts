import { bindings, defineConfig } from 'cf/config';
import * as entrypoint from './worker.mjs' with { type: 'cf-worker' };

export default defineConfig({
  worker: {
    name: 'aeo-html-stream-probe-20261105',
    entrypoint,
    compatibilityDate: '2026-11-05',
    workersDev: true,
    previewUrls: false,
    env: {
      PROBE_TOKEN: bindings.secret(),
      PROBE_EXPIRES_AT: bindings.secret(),
    },
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: { invocationLogs: false },
      traces: { enabled: false },
    },
  },
});
