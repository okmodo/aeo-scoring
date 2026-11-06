# Audit service contract v1

This is the proposed wire contract for frontend integration. The backend chat owns this directory, the service routes and response fixtures. The frontend chat owns presentation, its adapter from these types to view models, and any mock transport under its own files. Agree on a change to shared build configuration, dependencies or integration entry points before either chat edits them.

## Routes and lifecycle

| Request | HTTP | Body |
| --- | --- | --- |
| POST /api/v1/audits with a JSON object containing only url | 202 | Pending assessment. Poll the supplied statusUrl. |
| POST for a fresh reusable result | 200 | Original assessment ID, original timestamps and cache.hit true. |
| GET /api/v1/audits/{id} | 200 | Current assessment, including terminal retrieval failures. |
| Invalid JSON, shape or target URL | 400 | Error response with invalid_input. |
| Rate limit reached | 429 | Error response with rate_limited and a Retry-After header in seconds. |
| Unknown or expired report | 404 | Error response with not_found. |
| Unsupported request method | 405 | Error response with method_not_allowed and an Allow header. |
| Service or binding unavailable | 503 | Error response with service_unavailable. |

Assessment statuses are pending, complete, incomplete and unable_to_assess. Poll pending reports with backoff starting at two seconds and stop on a terminal status. An HTTP 200 on polling means the assessment resource was retrieved. Its status determines the audit outcome.

The submitted URL retains its path and query and drops its fragment. It must be a public HTTP or HTTPS URL without credentials. Submit only URLs suitable for an unlisted report. The unguessable report ID is the link for anyone who has it. Responses carry no-store and noindex directives. The service asks for no identity or contact information.

## Field definitions

- version is the wire contract major as a string. id is an opaque identifier. statusUrl is a same-origin relative path.
- submittedUrl is the normalized input. assessedUrl is the final fetched document URL, when available. createdAt, completedAt and expiresAt use ISO 8601 UTC timestamps.
- cache.hit indicates that this submission reused an existing assessment. cache.validUntil is the reuse deadline. Polling uses the original timestamps. A link can still be read after the reuse deadline until expiresAt.
- report is populated for complete and incomplete statuses. error is populated for unable_to_assess. Both are null while pending.
- rubricVersion identifies the scoring rules. category, productName, variant, market and currency are nullable when undetermined.
- score is populated only on complete reports. Its total, structure and content values are points with fixed maxima 100, 40 and 60. Render plain values without readiness bands. For incomplete reports show “Assessment incomplete” and identify unmeasured checks. earnedPoints is an unscaled subtotal for assessed evidence and must be described as partial when score is null.
- Each criterion lists its pillar, maxPoints, points, complete flag and subchecks. A subcheck lists its rubric ID, maxPoints, measurement status, nullable fraction and points, evidence IDs and nullable reason. A zero for measured evidence is distinct from null for an unmeasured or excluded check.
- Evidence entries contain an ID, source URL, retrieval method, UTC observation time, source location, kind and short excerpt. For kind derived_observation, excerpt is the service’s interpretation of the source at that location. For source_excerpt, it is source text. Treat both as untrusted plain text. coverage contains measured, notMeasured and total check counts, category, nullable extraction metadata and limitations. Extraction flags describe parser observations. Visibility remains unknown.
- fixes is ordered for presentation. Each fix names an owner role, affected checks and evidence, and a condition for recoverablePoints. A null value means the recovery is unknown. Conditional figures apply to the stated fix and evidence.
- A terminal failure displays “Unable to assess” and has no report or score. Error codes distinguish robots_blocked, robots_unavailable, retrieval_timeout, retrieval_failed, unsupported_content, response_too_large and assessment_timeout. Other errors are mapped to retrieval_failed. Display error.message as plain text. retryAfterSeconds is null outside rate limits.
- The proposed service admits up to five submissions per client per UTC hour and sixty globally per UTC hour. Accepted submissions and cache hits share the limits. Successful complete and partial reports are reusable for one hour and readable for 24 hours from submission. Pending work has a 60-second lease. These defaults are product decisions for this proposal.

## Frozen examples

Each JSON file under examples is the response body for the matching scenario. assessment-complete.json is an explicitly synthetic full-rubric fixture for report UI development. The current deterministic backend can produce incomplete reports when remaining applicable checks require evidence or judgment outside its supported checks. No live server is needed to use the fixtures.
