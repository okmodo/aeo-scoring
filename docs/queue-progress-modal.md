# Queue progress modal

The feature branch `codex/queue-progress-modal` integrates the reviewed frontend modal with the queue backend based on `ce27d19`. The backend integration branch is the PR target; main has not yet incorporated that engine. No branch is merged or deployed to production as part of this change.

The authenticated audit response gains optional `progress`: version `1`, audit ID, a monotonic revision and bounded public stage events. The backend projects only fixed stage/status fields from persisted queue, retained preparation readiness and pipeline diagnostics. It does not expose raw diagnostics, merchant content, provider responses or credentials. Unsupported or malformed optional progress is ignored safely by the frontend; supported legacy reports remain readable.

The customer workflow maps retrieval to Page download, preparation to Data extraction, assessment to AI Review and scoring to Score Card Building. The fifth row, Audit complete, stays waiting until the final report is actually published. Queue admission before processing produces Waiting to start. Internal scoring-completed diagnostics and queue acknowledgements alone do not permit a success banner. Published incomplete reports open with partial findings and no fabricated final score; failures, skipped work and explicit recovered outcomes stay distinct.

Preparation start/ready markers and score-card start are persisted idempotently. Validated assessment is recorded before report assembly. Progress is bounded to sixteen retained diagnostics and fixed public enum values; retries do not create an unbounded history. Additional indexed status reads and bounded marker writes fit within existing invocation reservations. CPU, model timeout, usage ceilings, password transport and production configuration are unchanged.

The frontend rejects mismatched audit IDs, older revisions and terminal-to-pending regressions. A same-audit terminal response remains authoritative when optional progress is missing, malformed or at the same revision. Client cancellation stops waiting and does not claim to cancel backend work. Pending polling respects the server audit expiry, with a bounded initial-request timeout.

## Local review

The existing Docker frontend remains on `http://127.0.0.1:4382`. Its nginx proxy routes `/api/v1/` to the local-only service at `127.0.0.1:4383` via Docker Desktop's `host.docker.internal`. A local asset shim redirects the frontend's audit requests to its own origin. It does not generate progress or reports in the browser.

Start the review API with Node 24: `node scripts/local-progress-review.mjs`. It uses the actual queue/runtime, SQLite D1 adapter, persisted pipeline events, keyed response store and report API. Capture and model responses are frozen fictional fixtures. The CLI uses separate work delays so progress is visible for review; these are fixture processing delays and are not production timing guarantees. No live external fetch fallback exists. The local-only review credential is `review123`; it is not a production secret.

Local SQLite files are created under the operating system's temporary directory and may be removed by cleanup. Review responses are fictional and must not be used as merchant assessments. The harness and local nginx deployment are never run by CI.

## Verification and branch provenance

Permanent contract/render and queue integration checks run through `test:preview`, `test:progress`, `test:queue-progress` and `test:backend`. They include duplicate/out-of-order deliveries, malformed progress, publication gating, skipped/recovered outcomes, failure and partial reports, authentication and one indexed progress join per poll. Native Worker packaging is checked by `test:browser-build`.

The required main-base evaluator invocation is performed and its observation retained privately. Because the actual integration base is the backend feature branch, the final PR evaluation record and history gate use `origin/codex/terra-gateway-payload`, matching hosted CI's real base. Existing backend branch plans/evidence are not rewritten, and evaluator/CI policy is not weakened. The reviewed report UI/catalog is carried from `6194bbe` without importing its old evaluation history or modifying rubric/scoring gold expectations.
