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

The production guard consumes persisted evidence for a pinned account and subscription. Caller-supplied verified flags and direct evidence objects are ignored. Evidence must identify the current subscription cycle, UTC AI day and all supported usage metrics, with current per-metric watermarks. The [local collector and reconciliation](usage-collector.md) now acquire and persist diagnostic observations, but the documented provider cannot establish authoritative completeness or freshness; no production receipt activation is implemented. It must reject contradictory snapshots and decreasing cumulative request, CPU, D1 operation or daily AI usage within the same period; legitimate stock changes and period resets require separate reconciliation. Missing, stale, future, malformed, overlapping-cycle or exhausted evidence denies admission. Conservative double-counting of local reservations already present in account evidence is intentional.

Service submission, polling and cached-report reads require a successful, nonduplicate allowance reservation before audit database or retrieval work. Both inference runners require the allowance guard. Reports are bounded to 256 KiB. Project configs set the CPU limit to 1,000 ms per invocation and disable runtime log and trace ingestion. The allowance ledger still reserves 2,000 ms per invocation as headroom because Cloudflare allows occasional overruns. This reservation is an estimate. Network timeouts still bound elapsed waits and protect audit completion. Cloudflare excludes network waits from Worker CPU time. [Worker CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)

## Activation status and remaining proof

Production activation remains disabled. No production allowance guard is constructed, so the proposed Worker returns the existing `503 service_unavailable` response and scheduled maintenance performs no work. Exhausted injected guards use the existing `429 rate_limited` response. The existing live app has not been changed. The injected guard and provisional database/storage operation envelopes are for offline validation, not an approved operational allocation.

Before activation, obtain trusted account-wide usage and actual billing-cycle evidence; account billing access last returned 403. Quantify D1 reads, writes, index and physical storage overhead, including reservations, denied attempts, retention and cleanup. Bound reservation-history retention and reconciliation without resetting consumed budgets. Confirm per-invocation CPU configuration on the deployed version and test on D1, not only local SQLite. Independently reserve the entire experiment allowance before any live calibration or deployment. Model extraction and the complete real-product report still need representative calibration; both calibration gates stay false.

## Billing guarantee boundary

This is a hard application admission policy, not a guaranteed $5 invoice. An inbound request is billable before application admission, and unrelated services consume shared allowances independently. A denied request and a budget-ledger query can themselves consume resources. Delayed billing data cannot provide synchronous account-wide headroom. Do not represent alerts, counters or a successful HTTP response as a billing cap.

Cloudflare budget alerts notify without pausing usage. Its documented spend-policy API covers Workers and Durable Objects, requires a positive cent threshold, and reports asynchronous estimates/enforcement; it does not establish zero-overage protection for all services. [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/), [spend-policy API](https://developers.cloudflare.com/api/resources/billing/subresources/spend_policies/methods/create/). No billing or unrelated-service settings were changed. Activation requires a reviewed approach to these remaining risks; uncertain headroom means keep audits paused.
