# Prepared-data rubric assessment

The backend starts assessment after D1 records `prepared_state = ready`. It loads the verified, unexpired prepared artifact from R2. The original download remains separate; it is not the AI assessment input. Retention remains 24 hours.

The model proposes observations and rubric findings. Application code validates the cited evidence and calculates points from the existing rubric anchors. Structure remains /40 and Content /60. This change does not introduce readiness bands or change criterion weights.

## Evidence failures

An observation is a proposal, not an admission prerequisite. Invalid observations are rejected individually. A finding requires its own valid, eligible evidence; an unrelated bad observation or finding must not discard supported results.

Quotation validation permits exact text and conservative entity/whitespace normalization. It must preserve numbers, units, negation, product identity and variant context. A model cannot cite a section outside the sources supplied to its request. Structured field references require a verified field path and exact value in an eligible structured source; a fabricated `brand: value` string is not a quotation.

Citation validation proves provenance, not semantic truth. The model must still establish that an excerpt concerns the primary product and supports the rubric anchor. Related products, hidden content and unselected variants must not be treated as primary product facts. Cleaned HTML does not establish computed visibility.

Missing or invalid evidence makes the affected finding unmeasured. Invalid category evidence prevents category-specific expectations from being established, while independent direct checks may proceed. Missing applicable checks retain **Assessment incomplete** with no final score. Retrieval failure retains **Unable to assess** with no numerical score. An unknown finding does not earn zero credit or become not applicable by default.

## Runtime and cost boundaries

The existing account-wide 60% admission checks and conservative reservations remain required before work. The Worker CPU cap remains 1,000 ms. The model response wait remains 15 seconds, clipped by the invocation deadline; that wall-clock wait is distinct from CPU time.

Completed model checkpoints replay without a second model call or AI reservation. Started or uncertain calls remain held and are not automatically retried. A policy version separates the new assessment behavior from earlier cached failures. No live calls belong in CI.

The front end, public contracts, unrelated Cloudflare services, model selection, paid integrations and dependencies are outside this change. Offline regression and independent review precede a PR; production activation requires separate merge/deployment authorization.

## Validation limits

Frozen synthetic fixtures exercise mixed valid and invalid citations, category fallback, report persistence and checkpoint replay. They do not establish live-model accuracy or a complete result on every merchant page. Typed structured references work only for complete eligible JSON sources; this change does not parse a new structured product representation from HTML.

The existing multi-stage assessor still collects observations and inspections before its final rubric judgment. A large prepared page can require many separately reserved model calls. A provider timeout or exhausted allowance before that final call can still prevent a finished assessment; this change fixes evidence validation, not that scheduling limitation. Missing initial-document evidence and unknown visibility also remain genuine coverage limitations.

New submissions use `prepared-assessment-v2`. Older audits are left unchanged; no migration or reassessment is part of this work.
