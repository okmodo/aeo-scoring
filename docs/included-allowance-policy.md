# Included-allowance operating policy

The user authorized Workers Paid on November 10, 2026, with the $5/month subscription as the only approved Cloudflare charge. Usage overages, paid add-ons, prepaid credits and external paid APIs are not authorized. Operate below 60% of each included account allowance. This supersedes the earlier Free-only deployment requirement; all other scope and release controls remain. Do not change unrelated Cloudflare services or the frontend.

| Metric | Included allowance | Maximum operating allocation |
| --- | ---: | ---: |
| Worker requests | 10,000,000 per billing cycle | 6,000,000 |
| Worker CPU | 30,000,000 ms per billing cycle | 18,000,000 ms |
| D1 rows read | 25,000,000,000 per billing cycle | 15,000,000,000 |
| D1 rows written | 50,000,000 per billing cycle | 30,000,000 |
| D1 storage | 5 GB | 3 GB |
| Workers AI | 10,000 neurons per UTC day | 6,000 neurons |

These are shared account ceilings, not independent allocations for every project. Subtract other account usage and conservative local reservations; an application may receive a smaller allocation. Storage is a stock and must not reset when the billing cycle changes. AI resets at UTC midnight. Monthly counters use the actual subscription period, not calendar-month assumptions. Storage uses decimal bytes conservatively. Workers/Pages builds, logs, traces and every other product need their own reviewed allowance before activation; they are not implicitly authorized by this table. Runtime logs/traces are disabled in the proposed audit configs. OpenAI, Browser Run, R2, Queues, Workflows, Durable Objects, paid model variants and other integrations remain inactive for this change.

Sources checked November 10, 2026: [Workers and D1 pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing).

## Implemented safeguards

`backend/allowance-policy.mjs` is the versioned ceiling source. `backend/allowance-store.mjs` uses one conditional SQLite insert and transactional triggers to reserve all requested metrics atomically. Indexed counters replace scans over reservation history. Idempotent retries cannot reserve a different amount under the same identifier. Reservations are not refunded after failure or timeout. A true multi-connection SQLite test checks contention and all-or-nothing reservations.

On November 11, 2026, the user accepted analytics sampling and reporting delay and authorized production admission using the available account data. The Worker collects account-wide Workers request and CPU totals, D1 row totals, D1 storage maxima per database over the preceding 24 hours, and Workers AI neurons for the UTC day. It gets the actual current period from the pinned Workers Paid subscription. Successful empty aggregates become estimated zero in this mode. API failures, malformed responses, invalid scope and unsupported billing windows deny admission.

`backend/analytics-allowance.mjs` caches an explicitly labeled `analytics_estimate` receipt in D1 for five minutes, refreshed on demand. Receipt watermarks in this mode represent collection time. They make no claim about provider completeness or ingestion lag. Counters retain their maximum observed estimate within the relevant cycle or AI day, including concurrent refreshes. The existing atomic ledger adds conservative local reservations on top of the observed account estimates. Sampling, unreported activity and concurrent unrelated services can still make actual usage higher. A failed refresh denies admission and backs off for 30 seconds. The diagnostic-only local billing collector remains separate and cannot activate production admission.
Service submission, polling and cached-report reads require a successful, nonduplicate allowance reservation before audit database or retrieval work. Both inference runners require the allowance guard. Reports are bounded to 256 KiB. Project configs set the CPU limit to 1,000 ms per invocation and disable runtime log and trace ingestion. The allowance ledger still reserves 2,000 ms per invocation as headroom because Cloudflare allows occasional overruns. This reservation is an estimate. Network timeouts still bound elapsed waits and protect audit completion. Cloudflare excludes network waits from Worker CPU time. [Worker CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)

## Production configuration

The Worker requires its project D1 binding, a pinned account and Workers Paid subscription, and the private `AUDIT_USAGE_READ_TOKEN` secret with account-scoped Billing Read and Account Analytics Read. The public configuration explicitly enables ungated audit access and keeps the existing service responses. Missing scope, credentials or usable estimates returns `503 service_unavailable`. Exhausting an allocation returns `429 rate_limited`. Scheduled maintenance remains paused. [Worker setup and access](usage-collector-access.md)

Account reads verified all six analytics quantities and the current subscription period with the updated token. Production verification must confirm the deployed 1,000 ms CPU limit and exercise the same ledger on D1. Comprehensive model and report calibration remains separate work.

## Billing guarantee boundary

This is a hard application admission policy, not a guaranteed $5 invoice. An inbound request is billable before application admission, and unrelated services consume shared allowances independently. A denied request and a budget-ledger query can themselves consume resources. Delayed billing data cannot provide synchronous account-wide headroom. Do not represent alerts, counters or a successful HTTP response as a billing cap.

Cloudflare budget alerts notify without pausing usage. Its documented spend-policy API covers Workers and Durable Objects, requires a positive cent threshold, and reports asynchronous estimates/enforcement; it does not establish zero-overage protection for all services. [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/), [spend-policy API](https://developers.cloudflare.com/api/resources/billing/subresources/spend_policies/methods/create/). No billing or unrelated-service settings were changed. The user accepts the analytics limitation for production testing. Failed collection and observed exhaustion still deny admission.
