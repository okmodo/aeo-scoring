import { bindings, defineConfig, triggers } from 'cf/config';
import * as entrypoint from '../public-worker.mjs' with { type: 'cf-worker' };
import { MAX_INVOCATION_CPU_MS } from '../allowance-policy.mjs';

const databaseId = process.env.AEO_PUBLIC_AUDIT_DB_ID;
if (!databaseId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(databaseId)) {
  throw new Error('Set AEO_PUBLIC_AUDIT_DB_ID to the dedicated public audit D1 database ID.');
}
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const subscriptionId = process.env.CLOUDFLARE_SUBSCRIPTION_ID;
if ((accountId || subscriptionId) && (!/^[a-f0-9]{32}$/.test(accountId ?? '') || !/^[A-Za-z0-9_-]{1,128}$/.test(subscriptionId ?? ''))) {
  throw new Error('Set both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_SUBSCRIPTION_ID to the verified billing scope.');
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
      AUDIT_USAGE_READ_TOKEN: bindings.secret(),
      AUDIT_AI: bindings.ai(),
      AUDIT_PREVIEW_PASSWORD: bindings.secret(),
      AUDIT_PUBLIC_ACCESS: bindings.text('enabled'),
      AUDIT_BILLING_ACCOUNT_ID: accountId ? bindings.text(accountId) : undefined,
      AUDIT_BILLING_SUBSCRIPTION_ID: subscriptionId ? bindings.text(subscriptionId) : undefined,
    },
    triggers: [triggers.scheduled({ schedule: '0 * * * *' })],
    observability: {
      enabled: false,
      logs: { enabled: false, invocationLogs: false },
      traces: { enabled: false },
    },
  },
});
