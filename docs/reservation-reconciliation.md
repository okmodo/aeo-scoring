# Reservation reconciliation

The user authorized this correction on November 11, 2026 after the old guard added 805 observed neurons to 5,322 retained worst-case reservations. The 60% included-allowance ceilings and 1,000 ms CPU limit are unchanged. This is accounting work, not approval of AI scoring calibration.

## Admission calculation

For each account, metric and accounting period, admission uses:

`max(latest retained account estimate, anchor baseline + settled consumption - anchor cutoff) + unresolved holds + proposed reservation <= operating ceiling`

An anchor atomically captures both the existing settled counter and a baseline equal to the greater of that counter and the account estimate. Its cutoff never moves during the period. Subsequent known local consumption therefore remains counted when analytics is delayed; an estimate catching up does not add the same completed consumption a second time. Every unresolved hold remains additive, including earlier-period work whose completion is uncertain. Samples may already include some unresolved work, so that portion remains deliberately conservative until settlement.

Monthly metrics use the actual subscription cycle. AI uses the UTC day. Storage is a persistent stock with a persistent anchor, not a monthly allowance reset. Pending counters are account-wide and carry across boundaries. A completion crossing one UTC midnight or a proven adjacent billing cycle is charged conservatively in both periods. Invalid chronology or ambiguous longer spans retain the hold.

## Completion evidence

The backend keeps each original reservation immutable and appends one idempotent settlement. Provider-root positive token counts and valid completed-response metadata establish AI consumption; model-generated `usage` text is ignored. The charge rounds up the greater of reported provider neurons and the pinned model's token-rate estimate. Token-derived values are estimates, not measured CPU or account billing counters. A completed response that reaches its output limit can settle even when its model JSON is unusable. A two-call assessment settles only when both issued calls have reliable usage. Missing usage, an unresolved exception or a timeout retains the original hold; a late response cannot release it after timeout.

Requests, CPU, D1 operations and potential storage growth retain their original conservative reservation amounts as completed consumption. The runtime cannot measure these quantities exactly per invocation. It does not invent measurements or release them to zero. The request's combined invocation hold settles only after both its response work and registered background work finish. Failed settlement persistence retains the hold. Usage above a reservation is recorded in full and can block subsequent admission.

SQLite triggers update fixed-size pending and period-settled counters atomically. Admission does indexed point lookups, not scans over historical reservations. Receipt generation and scope are checked inside conditional writes. Database constraints reject invalid or underfunded settlements. Duplicate completions cannot release capacity twice.

## Deployment and historical reconciliation

1. Apply `backend/migrations/0002-reservation-reconciliation.sql` to this project's existing database while the old Worker remains deployed. Its bootstrap is a single atomic recomputation of all six pending counters from immutable history, safe with old writers before or after that statement. The migration can be replayed without losing or duplicating holds.
2. Verify every historical target's exact account, ID, original costs, cycle and AI day before changing any hold. The frozen `evals/changes/reservation-reconciliation/legacy-settlement.json` maps seven reservations to nine retained provider receipts. Independent review must confirm all hashes and usage calculations. No unrelated or uncertain reservation is cleared.
3. Append the verified settlements before the first new admission creates anchors. For the retained test cohort, 5,322 reserved neurons become 809 conservatively rounded completed neurons. With an account estimate of 805, the initial floor is 809, rather than 805 plus 809. Original reservations and the old counters remain available for audit.
4. After independent review and hosted CI, deploy the exact backend bundle preserving all current access settings and secrets. Verify actual database admission, deployed bundle, CPU cap and frontend-origin access behavior. Keep AI activation off until its separate real-product validation passes.

## Remaining limits of analytics

The user accepted account analytics sampling and reporting delay. This calculation preserves known local consumption and observed account usage; it cannot identify unreported concurrent consumption by unrelated services or prove which pending call is included in a sample. It remains an estimated application admission policy, not a guaranteed $5 invoice. Failed collection still denies admission. No billing settings or unrelated service settings are changed.

References: [D1 transaction batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), and [the operating policy](included-allowance-policy.md).
