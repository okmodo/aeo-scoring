import { bindings, defineConfig } from 'cf/config';
import * as entrypoint from './worker.mjs' with { type: 'cf-worker' };
// Dedicated new Worker; confirm name remains absent before the separately reviewed deployment.
export default defineConfig({ worker: {
  name: 'aeo-content-runtime-probe-20261109-kk7', entrypoint,
  compatibilityDate: '2026-11-09', compatibilityFlags: ['global_fetch_strictly_public', 'cache_option_enabled'], workersDev: true, previewUrls: false,
  env: { PROBE_SECRET: bindings.secret(), PROBE_EXPIRES_AT: bindings.secret() },
  observability: { enabled: true, logs: { enabled: true, invocationLogs: true, headSamplingRate: 1 },
    traces: { enabled: false } },
} });
