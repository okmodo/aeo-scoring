# Cloudflare CPU benchmark: preparation and evidence

This is a preparation guide, not deployment authorization or a completed experiment. The frozen [closure protocol](phase-2-closure-protocol.md) governs launch eligibility and decisions. The separate [architecture pilot](phase-2-architecture-pilot.md) permits at most 30 requests total, which cannot pass the closure protocol's 30-successes-per-class gate. The measured outcome would be exploratory and the closure gate remains inconclusive. It also requires actual account-wide headroom and maximum CPU, neither of which this analytics query establishes.

## Read-only checks made

On 2026-11-05, an authenticated Cloudflare GraphQL schema introspection found `AccountPagesFunctionsInvocationsAdaptiveGroupsQuantiles.cpuTimeP50`, `cpuTimeP95`, and `cpuTimeP99`, described by Cloudflare as microseconds. The dataset also exposes `scriptName`, `status`, time dimensions, request and error sums, and `wallTime`; its filter supports `scriptName`, `status`, `datetime_geq`, and `datetime_lt`. An account query spanning 2026-11-04 through 2026-11-06 returned an empty array without GraphQL errors. This verifies access and query shape, not that a new deployment will populate data or that small samples are unsampled. An account Browser Run session-list GET returned an empty list, which does not establish daily remaining browser time or include all Quick Action usage.

## Prerequisites and deployment boundary

The independent reviewer must first review the exact benchmark bundle and fixed request budget. Hosted CI and review must pass for the exact commit, and the account owner must authorize the isolated experiment. Only the user-confirmed Workers Free account is eligible. Recheck account identity, candidate project absence, current service limits and existing-resource inventories. Use a new Direct Upload Pages project with a unique name; never alter the existing preview, an older resource, account Workers subdomain, routes, DNS, billing, or paid services. Never create a Workers subdomain. Stop on a collision, unexpected response, quota error, or any ambiguity. Do not perform cloud calls in CI.

The draft `benchmark-worker/worker.mjs` uses fixed synthetic 2 KiB, 128 KiB and 1 MiB inputs and an oversized error case, and accepts no caller-supplied HTML or URL. A random 256-bit bearer token is checked with Cloudflare's timing-safe comparison; a single atomic conditional D1 update consumes a global permit only while the database clock is before expiry. Missing bindings, failed authentication, database errors and exhaustion fail closed. The code and setup require independent review and runtime validation; local mocked tests cannot establish D1 production behavior. Configure the token as a secret only on the new benchmark project, keep it out of source, logs and URLs, and never reuse it. Freeze input hashes and expected results before the run.

Build from the reviewed commit with `node benchmark-worker/build.mjs /private/tmp/aeo-cpu-bundle`; hash `_worker.js` and `static/index.html`. Feed only the `static` directory to the existing Pages asset uploader; attach the separately built `_worker.js` module in the deployment form. Validate the bundle has no external Node imports and no unreviewed dependency. Rebuild and compare hashes if necessary before deployment.

Create a new isolated D1 database after authorization and initialize exactly one row using the D1 query API. Select a fixed expiry before running, in UTC epoch seconds, short enough for the approved window. Never extend the expiry or replenish permits during the experiment:

```sql
CREATE TABLE budget (id INTEGER PRIMARY KEY CHECK (id = 1), remaining INTEGER NOT NULL CHECK (remaining BETWEEN 0 AND 30), expires_at INTEGER NOT NULL);
INSERT INTO budget (id, remaining, expires_at) VALUES (1, 30, ?);
```

The project creation API supports `deployment_configs.production.d1_databases.BENCH_DB.id` and `deployment_configs.production.env_vars.BENCH_TOKEN` with `{type: "secret_text", value: <token>}`. Use a cryptographically random 32-byte value encoded as 64 lowercase hex characters, transferred privately; do not print or commit it. Bind only the new database and set `fail_open: false`. Verify the returned project identity and binding metadata, without exposing the secret, before upload. Creation and setup are permitted only after the owner authorizes them and the exact commit has passed CI and independent review. Use the documented D1 API to verify the initial and final remaining count; unexpected values stop the run.

Cloudflare's Pages deployment API accepts either `_worker.js` as a JavaScript module or `_worker.bundle`, not both, in the multipart deployment request alongside the Direct Upload manifest. Follow the existing [preview procedure](hosted-preview-deployment.md) for provenance, token handling and inventory, substituting only the new benchmark project and reviewed benchmark assets. Treat the API response as authoritative; do not assume the preview's static deployment procedure includes the function bundle. Record source commit, bundle hash, project and deployment IDs, time window and all attempts. Any deployment or cleanup requires the specific authorization and independent review required by the protocol.

## Measurement query

Use `POST https://api.cloudflare.com/client/v4/graphql` with an authenticated request and the exact account, returned script identity, and UTC window. Example query, after substituting values through GraphQL variables:

```graphql
query Cpu($account: string!, $script: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: {accountTag: $account}) {
      pagesFunctionsInvocationsAdaptiveGroups(
        limit: 100
        filter: {scriptName: $script, datetime_geq: $start, datetime_lt: $end}
      ) {
        dimensions { scriptName status }
        sum { requests errors wallTime }
        quantiles { cpuTimeP50 cpuTimeP95 cpuTimeP99 }
      }
    }
  }
}
```

Validate variables and script identity with a read-only query before interpreting results. Grouping does not expose a workload or request-path dimension; use nonoverlapping recorded windows for each workload, and verify aggregation and data arrival rather than mixing classes. A sparse adaptive dataset and its quantiles cannot establish individual request values, maxima, cold/warm identity, or a 30-request success count without corroboration. Report missing, delayed, sampled, ambiguous or unmatched data as inconclusive. Record response status and client wall time separately; wall time includes waiting and is not CPU time. Do not infer remaining shared quotas from an empty dataset or a single user's locally tracked usage.

The pilot requires per-request Cloudflare CPU, which the aggregate query cannot provide. Cloudflare documents CPU time in Workers invocation logs, but Pages Functions documentation describes streaming logs that are not stored. Verify before deployment whether the specific Pages runtime yields per-invocation CPU in an accessible Free-plan log stream; otherwise the pilot's CPU evidence is unavailable. Tail Workers require a Paid or Enterprise plan and are outside this project's boundary. See [CPU in invocation logs](https://developers.cloudflare.com/changelog/post/2025-04-09-workers-timing/), [Pages Functions logging](https://developers.cloudflare.com/pages/functions/debugging-and-logging/), and [Tail Workers eligibility](https://developers.cloudflare.com/workers/observability/logs/tail-workers/).

Cloudflare references: [Pages deployment API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/create/), [GraphQL Workers metrics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), and [Browser Run session API](https://developers.cloudflare.com/api/resources/browser_rendering/subresources/devtools/subresources/session/).

For this pilot, Cloudflare rejected two initial new Pages project creation attempts because `fail_open` differed between production and preview (HTTP 400, code 8000066). A new isolated project was accepted only after both environments specified `fail_open: false`. Do not change any pre-existing project to address this requirement. The original deployed benchmark then returned 404 on its first small request; see the [runtime correction protocol](phase-2-cpu-runtime-correction.md) before any separately reviewed corrected run. The original attempt remains within the 30-request coordinator cap.
