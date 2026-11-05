---
tags: [aeo-scoring, specification, phase-1]
updated: 2026-11-04
status: scoring-foundations
---

# AEO Phase 1 Scoring Foundations

Phase 1 turns the agreed rubric into versioned scoring inputs and offline reference examples before building a live auditor. The score remains Structure 40 and Content 60, without bands, predictive claims, or arbitrary caps.

Canonical technical files are [rubric configuration](../../config/rubric.v1.json), [category templates](../../config/categories.v1.json), [crawler registry](../../config/crawlers.v1.json), and [scoring reference documentation](../../docs/scoring-foundations.md). The reference harness demonstrates arithmetic over assessed inputs; it does not fetch websites or judge product claims.

The initial editorial categories are running shoes, casual daypacks, and basic T-shirts. They provide explicit attribute pools and shopper-question anchors with scope exclusions and evidenced conditional applicability. They are starting templates pending Phase 2 calibration, not industry requirements or human-scored live reference data.

The crawler registry separates search, retrieval, user-triggered, and training roles. Vendor behavior remains unknown where official documentation does not establish it. Training and user-triggered bots do not consume the S5 scored pools. Agent-file criteria remain low-weight emerging practices.

Frozen examples are synthetic and version-controlled. Unknown categories, unmeasured checks, and unsupported applicability must not yield a misleading final score. Real-page extraction, model judging, production applicability verification, browser budgets, and calibration remain Phase 2 or later work.

CI and independent technical review remain required for each PR. The user removed GitHub's separate-account approval requirement; that repository setting is distinct from technical review and does not authorize automatic merges or paid usage.

Related: [[AEO Category Coverage]], [[AEO Verified Crawler Registry]], [[AEO Scoring Contract]], [[AEO PRs Require Evaluation Before Merge]], [[AEO Delivery Plan and Open Decisions]].

Project index: [[AEO Scoring Project Specification]].
