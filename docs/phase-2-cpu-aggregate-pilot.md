# Aggregate Worker CPU pilot supplement

Frozen before CPU outcomes. The separate [full protocol](phase-2-closure-protocol.md) is unchanged: its per-request and maximum gate remains unmet if only aggregate quantiles are available. This supplement allows a bounded diagnostic observation for the constrained architecture pilot; it is not a production feasibility pass.

After independent review and explicit owner authorization, use only a newly isolated Pages benchmark with fixed synthetic small, medium and near-limit workloads and an error case. Authenticate with a secret, enforce a fixed expiry and an atomic global maximum of 30 permits through a new isolated D1 database. Do not modify any pre-existing Cloudflare resource or enable a Workers subdomain. No arbitrary input, network fetching or paid resources. Verify free plan and available headroom as far as possible; if unavailable, report unknown. Delete only newly created pilot resources after capturing measurements and owner coordination. No cloud calls in CI.

Use at most 30 total requests across the fixed classes, in separately identified time windows per class where practical. Query Cloudflare Analytics for script/time-window CPU quantiles (median, p95 and p99 in microseconds), request counts and errors, preserving the exact query, windows, identifiers and accounting limitations. If per-request data or maximum is unavailable, say so. Aggregate quantiles may reflect other traffic, delayed sampling or window overlap; prevent or report those limitations. Ten or fewer observations in a class do not support a reliable p95, and the reported quantile is diagnostic only. Retain failures and missing analytics, never infer per-request maxima from a p99 or substitute elapsed time for CPU. Report actual resource counts, calls and measured usage without inventing costs.

A successful pilot may inform constrained design but does not satisfy the unchanged 30 successful requests per workload, per-invocation maximum, or full free-tier headroom gates. Those remain inconclusive without the required evidence.

## Frozen request allocation and inputs

Before any benchmark request, freeze a maximum of 30 authenticated admitted requests: nine small, ten medium, ten large and one oversized-error request. Stop at the first observed CPU-limit exceedance, platform quota error or HTTP 5xx; record actual attempted and successful counts, including any unattempted cases. These are permit caps for admitted work, not a platform-enforced cap on unsolicited traffic or account-wide spending. Analytics access is currently rate-limited; wait for recovery instead of repeatedly querying, and report headroom as unknown unless measured.

The reviewed Worker bundle SHA-256 is `104b2dac12d02a2b4c45e144f85d9053daf90e3e17e453f6c279972d6299b5ef`; the static index SHA-256 is `6f8747a193ae48994995fca44958c4b2f962d0d8cb87e60f929661363a8d4e67`. The exact fixed workload input bytes and SHA-256 values are:

| Workload | Bytes | SHA-256 |
| --- | ---: | --- |
| small | 2,048 | `eb3a3d1dbb09eecccc671072069468918073dca1c979b9e7a964fec588a49cc8` |
| medium | 131,072 | `91cee44ec79a313be02d2a31e1db7aec540ef5937af8b77e4625292e998d9c63` |
| large | 1,048,576 | `cc88b3c03329ac50092b29e3450b77f206920521c12f82917f3e7955e459b3a9` |
| error | 1,048,577 | `154b8ed3c2383ce429058768595935faf7851b5c38db2b1732594be1d88bc05a` |
