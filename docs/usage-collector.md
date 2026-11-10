# Usage collection and reconciliation

The collector is a local, operator-run, read-only management-API client. It does not create a Worker, schedule polling, run inference, deploy resources, or write to live D1. The standing operating ceiling remains 60% of every verified included allowance. Account-wide billing protection and production admission remain unapproved.

## Acquisition

`backend/usage-collector.mjs` makes at most three fixed GET requests: subscriptions, v1 usage metadata and v1 billable usage. Account and subscription identifiers are explicit. Requests do not follow redirects or retry; each response is limited to 1 MiB and each parallel acquisition is limited to ten seconds. Error bodies and credentials are not included in receipts. The collector matches actual subscription period start/end rather than deriving a calendar month or treating cancellation dates as period ends.

Metric labels require an explicitly reviewed mapping. The repository supplies only synthetic example labels; those are not a real Cloudflare mapping. Missing, mismatched, malformed, truncated, overflowed or unmapped data remains unknown. The collector uses returned ConsumedQuantity, never priceable quantity or zero cost as a proxy for total consumption. Returned rows are explicitly partial billing-period observations. Daily AI usage and instantaneous storage cannot be derived from those aggregates and remain null.

The documented v1 API does not provide a completeness watermark. Neither retrieval time nor ChargePeriodEnd proves current, complete, account-wide consumption. Receipts are therefore diagnostic and blocked, even after a successful authorized GET. Billing Read unlocks acquisition, not automatic audit admission.

## Persistent reconciliation

`runUsageCollection` calls `begin()` before acquisition. This increments a generation and invalidates prior admission immediately, including when credentials, transport or parsing fail. `finish()` serializes updates with a generation/pending compare-and-set; an older or competing completion cannot overwrite a later attempt.

The production transition evaluator checks normalized complete observations for account/subscription identity, period and UTC-day scope, watermarks, stale/replayed/out-of-order input, counter decreases and cycle/day transitions. Storage retains its conservative high-water mark; local reservations are not refunded. Partial observations are retained separately as untrusted diagnostic highs and cannot establish complete totals, lower counters or fresh eligibility. Complete normalized test observations are still untrusted; no receipt flag, public callback or direct evidence object grants authority.

The guard reads only persisted, active, current evidence for the pinned account and subscription and rechecks the generation atomically at reservation. This adapter has no path to activate that evidence. Future trusted-provider integration must be independently reviewed, discard/migrate untrusted diagnostic baselines, and establish authoritative coverage and cost bounds. Synthetic helpers only seed isolated test databases; they do not replace production reconciliation algorithms.

## Run safely

Use Node 24, as required by the project. Prepare a trusted private directory (owned by the operator, mode 0700); the SQLite file must be owned by the operator with mode 0600 and cannot be a symlink. State and output contain account identifiers and aggregate financial observations and must remain private. No secrets belong in command arguments, chat, version control, browser code, CI, or public logs.

Offline replay, from the repository root:

```sh
mkdir -m 700 /private/tmp/aeo-usage-private
node backend/usage-collector-cli.mjs --fixture backend/fixtures/usage-collector/diagnostic.v1.json --db /private/tmp/aeo-usage-private/state.sqlite
```

Exit code 2 means collection completed as blocked diagnostics; it does not indicate an available audit budget. Exit code 1 means a local configuration/storage error prevented completion. Repeating a collection advances the generation and never activates admission.

For an explicitly authorized read-only live run, supply `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_SUBSCRIPTION_ID` and `CLOUDFLARE_BILLING_READ_TOKEN` through a private environment, then omit `--fixture`. An optional `--mapping` file supplies reviewed exact labels and unit conversions; omitting it leaves quantities unknown. The token requires [one-account Billing Read access](usage-collector-access.md). Subscription identifiers must be selected from the authorized subscription listing; do not guess or select another subscription silently. The CLI does not consume Cloudflare Worker compute or write to live services.

## Remaining activation work

All three read-only permission probes returned 403 with the existing connection. After the correct credential is supplied, validate actual wire responses, subscription identity and mappings privately. Reporting completeness, lag bounds and current daily/stock measurements still require trustworthy sources. Real D1 costs, ingress, ledger retention and a bounded collector bootstrap also remain prerequisites for a deployed monitor. No alerts, hard spend policies, billing changes, runtime cron, migrations or deployment were configured by this work.
