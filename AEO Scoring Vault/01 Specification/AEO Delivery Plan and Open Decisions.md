---
tags: [aeo-scoring, specification]
updated: 2026-11-04
status: agreed-planning
---

# AEO Delivery Plan and Open Decisions

Planning precedes implementation. No application scaffolding, resources, deployment, or paid services are authorized by this specification commit.

Agreed product decisions: standalone project; Cloudflare free tier; TypeScript and Vite; both structure and content scoring in the first public release; plain score without bands; assignable actions with affected subchecks; recovery calculated from explicit rules without overlap; low-weight llms.txt and website agent guide criteria.

Next planning work:

- Finalize supported launch categories and their essential/supporting attributes, applicability rules, and decision-support questions.
- Publish a versioned retrieval crawler list and platform-specific robots/fetch behavior. Establish claim-support and confidence anchors, comparison tolerances, and relevant verification rules.
- Resolve whole-criterion non-applicability and unsupported page types before broad launch.
- Confirm report visibility/noindex, retention, export format, sharing, and re-audit/cache controls.
- Set brand, domain, and designated Cloudflare account.

After planning approval, validate feasibility on representative pages: CPU cost, raw extraction accuracy, need for rendering, browser/AI budgets, and judge agreement with human scores. Then implement the combined scorer, evidence, actions, and file generation; calibrate and launch within enforced free limits. A structure-only release does not satisfy the agreed first-public-release scope.

The handoff's Mizuno 51.5 example uses the superseded v0 rubric, includes provisional scoring, and lacks a frozen HTML fixture. It is background rather than a v1 regression target. Build a new snapshot-backed human calibration set.

Any free-tier failure requires discussion and a scope/architecture decision rather than silently upgrading. The earlier CLI check found cf installed but unauthenticated; verify account access when setup is authorized.

Related: [[AEO Product Scope]] · [[AEO Sources and Evidence Classes]].

Project index: [[AEO Scoring Project Specification]].
