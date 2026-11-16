# Shared audit report contract

The audit report is the source for the summary, points chart, test list and selected-test details. The frontend must not infer failed tests from missing results or manufacture a final score. Missing measurements remain incomplete; exclusions remain not applicable.

The shared runtime contract in `contracts/report-contract.mjs` supplies versioned customer copy and compatibility validation. Both the backend serializer and the frontend report model use it. The wire API remains `/api/v1`; its envelope version is distinct from the rubric version. Rubric 1.0.0 and 2.0.0 identify different test definitions and must select their own catalog. The checked-in v2 rubric is copied unchanged from the reviewed backend rubric-v2 implementation; it does not switch main's scoring engine or alter scoring weights.

New reports may include additive contract metadata. The frontend displays validated presentation text from new reports, so an engine update to an existing test’s customer copy is reflected without a separate frontend copy change. Existing supported reports without that metadata remain readable using the shared versioned catalog. Website quotations remain evidence, never markup. Recommendations use the audit's related findings and returned guidance, with standard test guidance as a fallback; they are not verified replacement product facts.

Unsupported versions, unknown tests and malformed results must show a clear report compatibility message with scores withheld. They must not silently become generic tests, zero scores or passing results. Invalid/unavailable evidence must not be presented as a verified website finding.

## Verification and release

`npm run test:preview` includes the report contract and render regressions on every PR. Frozen fictional reports cover legacy and current rubrics, measured and partial results, exclusions, incomplete reports and unsupported or malformed responses. Catalog coverage is checked against both versioned rubric files, and serializer output is exercised through the frontend model. Run `node --test test/report-contract.test.mjs test/live-report.test.mjs` for targeted checks under Node 24.

When the engine adds or changes a test, update the versioned rubric, shared catalog and producer/consumer fixtures together. A breaking change requires a new supported contract or rubric version and frontend support before the engine emits it. Backend feature branches must incorporate these shared contract changes before their next release; a passing check on an unrelated frontend branch does not prove the deployed engine branch contains them.

Frontend releases go to the existing Cloudflare Pages project. Worker releases remain separate and reviewed; a frontend build must never deploy the audit Worker. This integration makes no cloud changes, changes no password or admission limits, and performs no live model calls. Deploying it and verifying an authenticated live report are separate release steps.
