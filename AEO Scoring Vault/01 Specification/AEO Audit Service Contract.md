---
tags: [aeo-scoring, contract]
updated: 2026-11-05
status: proposed
---

# AEO Audit Service Contract

The proposed v1 contract lets the front end build against frozen JSON examples. An audit accepts a URL only and returns an unlisted report link. Complete reports show Structure /40 and Content /60 without readiness bands. Partial reports display “Assessment incomplete” and withhold the final score. Retrieval failures display “Unable to assess” without a numerical score. Fixes name an owner role and show potential points only under the stated conditions.

Proposed limits are five submissions per client and 60 globally per UTC hour. Results can be reused for one hour and reports can be opened for 24 hours. The backend owns the wire types, API routes and fixtures. The front end owns presentation and its adapter.

[Canonical contract and frozen examples](../../contracts/v1/README.md)

[[AEO Scoring Project Specification]] · [[AEO Assessment Evidence and Coverage]]
