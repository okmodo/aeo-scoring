# User-started audits only

Hourly maintenance no longer discovers or dispatches page preparation or AI assessment. It does not call the private `AUDIT_SELF.prepare()` or `AUDIT_SELF.assess()` entrypoints. Existing ready jobs, expired ownership leases and waiting checkpoints do not trigger scheduled AI work.

An explicit audit submission still initiates capture, preparation and the normal bounded assessment continuation. Public report polling does not start processing. A dropped or interrupted chain, including one that reaches the eight-hop bound, will no longer be resumed by the hourly schedule. This change adds no manual-resume API and does not automatically retry uncertain model calls. Submitting the same URL may reuse an existing cached or pending audit; submission is not a new resume control.

The hourly cron remains `0 * * * *`. It performs only:

- Usage-guarded safety checks that may close stale project-owned browser sessions.
- Expired retained-page deletion under the existing 24-hour retention policy.
- Bounded deletion of expired pipeline/work records, prepared assessment jobs and checkpoints.

Unexpired pages and jobs remain stored until their original expiration. Cleanup does not release unknown provider usage holds. The existing private R2 lifecycle configuration and account analytics limitations remain unchanged.

## Usage boundaries

Maintenance reserves usage before touching job data or invoking its watchdog. Cleanup has a separate conservative reservation for up to 10 snapshot rows, 100 pipeline rows, 100 work rows, 100 checkpoints and 25 jobs, plus ledger overhead: 500 D1 writes. This reservation is an allowance booking, not a higher usage ceiling. The 60% operating limits and 1,000 ms CPU cap remain unchanged, as do the 30-second model timeout and all per-call AI admission checks.

If admission fails, the guarded work is skipped. Physical expiration cleanup can therefore occur after the retention deadline; stored data is unavailable for assessment after expiration, and the existing R2 lifecycle remains a separate deletion safeguard.

## Validation and rollout

Frozen real SQLite/R2-compatible fixtures assert that maintenance removes expired records, preserves unexpired waiting audits, never accesses the private execution binding, and does nothing after a denied admission. Existing user-submission and report-polling tests confirm the permitted execution path. A fresh agent runs maintenance from exported pending/expired state and records actual cleanup without AI dispatch.

Deploy only the reviewed project backend after hosted CI. Preserve the existing hourly schedule, bindings, secrets, release flags, monitoring and resource limits. Frontend files, dependencies and unrelated Cloudflare services are outside scope. The user's instruction to disable recovery is the authorization for this production behavior change.
