# Prepared-ready AI assessment

The AI consumer begins at `retained_snapshots.prepared_state = 'ready'`. It does not download original HTML, invoke the parser, or wait for `inputs_state`. The existing preparation publisher owns that readiness flag; assessment jobs never change it.

## Input and integrity

`createSnapshotStore().readPrepared(auditId)` reads only the private `/prepared` artifact and `/snapshot` retrieval metadata. It validates D1 state, object sizes and hashes, format, preprocessing provenance and original 24-hour expiry. Source references are checked against D1's original hash/size without loading `/html`. The consumer always supplies the same minimal extraction envelope. Optional `/inputs` publication cannot change an assessment's checkpoint inputs.

The prepared artifact contains cleaned rendered HTML, not the original response. Its content is supplied to the existing cleaned-evidence source builder without original HTML, duplicate extraction JSON, or repeated per-element excerpts. This is one canonical evidence representation, not a promise of one model transmission: independent extraction, category, inspection, support and judgment stages can inspect the same prepared sources in separate, individually reserved requests. Exact source quotations are validated; cleaned/rendered content does not establish computed visibility or initial-response S1/S2 evidence. Missing applicable evidence remains unmeasured.

## Dispatch and recovery

The public Worker exports the private `AuditContinuation` RPC entrypoint. The project-only `AUDIT_SELF` service binding points to that entrypoint on the same existing Worker. No public HTTP route exposes its methods. Required public browser submissions fail closed if the binding is missing.

Capture completion notifies preparation independently of report polling. Automatic preparation publishes and verifies `/prepared`, notifies AI, and stops. It does not run optional extraction or write `/inputs`. Explicit legacy reads can still request extraction separately. The AI consumer independently checks D1 readiness and atomically claims a job. A prepared-ready row can be consumed with no parser inputs at all. An older incomplete report can be reassessed only under a new current-policy claim; completed reports are preserved. Cache keys include the input/job policy.

Each AI invocation runs at most one new model call, saving its validated parsed response as a checkpoint. Later invocations replay completed steps without another model call or neuron reservation. A checkpoint's input digest must match. Started or uncertain calls are not automatically repeated; unknown usage remains reserved. Jobs are fenced by audit ID, prepared hash, policy, owner and lease. Publishing findings and reports requires the current live owner.

RPC continuations are capped at eight hops per chain, below the documented platform request-chain ceiling. Reaching that cap leaves a resumable job waiting. The existing hourly project maintenance event discovers at most three ready AI jobs and three missed preparation notifications. It restarts fresh chains and recovers expired leases. There is no new queue/product or minute cron. A dropped continuation or a chain cap can therefore delay assessment until a later hourly event; immediate delivery is best effort, while durable state supports recovery.

Five unsuccessful claims exhaust normal crash retries. A terminal-only claim then publishes an explicit incomplete result rather than leaving the audit pending indefinitely. Successful checkpoint yields do not consume crash retries. An interrupted prepared publication remains pending and is not overwritten; fenced recovery reports preparation failure unless a concurrent publisher has made it ready. Expired job/checkpoint cleanup uses indexed expiry and bounded batches (100 checkpoints and 25 jobs).

## Limits and results

All existing account-wide 60% operating ceilings and the 1,000 ms CPU cap remain unchanged. Every internal invocation reserves Workers/D1 costs, every R2 operation uses the R2 guard, and every real model call uses the existing neuron admission and provider-usage settlement. Replay does not reserve or charge another model call. The existing accepted analytics sampling/reporting limitation remains.

`planPreparedAssessment` reports verified input bytes, source/batch counts, conditional call ceilings and conservative neuron bounds. Each model response waits at most 15 seconds, or the shorter remaining invocation deadline. Requests remain bounded to 60 KiB with at most 4,000 output tokens; a job cannot exceed 128 model steps. Bounds are explicit, with no silent truncation. The 512-section guard remains for legacy inputs but is not a prepared-readiness gate. The current model and conservative byte-based neuron reservations are unchanged: sufficiently large artifacts may exhaust the 6,000-neuron daily operating allowance before completing. The planner is an upper-bound disclosure, not a guarantee that a whole audit fits the remaining allowance.

Profile, replayable findings and the deterministic report are retained through existing private storage. Structure remains /40 and Content /60. An assessment can finish its execution yet produce an incomplete report when supported evidence cannot resolve all checks; no final numerical score is invented. Preparation, integrity, model, budget, validation and persistence errors remain distinguishable through private codes. The public report status contract is unchanged.

## Rollout and verification

Apply project migration `0011-prepared-assessment-jobs.sql` after existing `0010-prepared-html.sql`. Deploy the reviewed bundle with the new project self-binding, preserving all active secrets, release flags, compatibility settings, monitoring, hourly cron, AI/R2/D1/browser bindings and CPU cap. No frontend or unrelated service changes are required.

Offline coverage includes real SQLite/R2-compatible ready-only readback, forbidden original/input reads, tampering/expiry, concurrent ownership, checkpoint replay, retry exhaustion, preparation failure/races, positive validated findings and retained report publication. A fresh agent resumes exported ready data and a completed checkpoint. A native local workerd test exercises the actual RPC entrypoint after its submitting HTTP response closes, caps a chain at eight calls and restarts it from a fresh invocation. These tests are not Cloudflare production CPU, model-quality or billing verification.

A separately budgeted native rollout check must verify the ready transition, model invocation, checkpoint/usage state, retained findings where the provider returns valid output, and observed production CPU. Model timeouts and unknown billing evidence remain explicit limitations rather than passing reports.

Primary runtime reference: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/
