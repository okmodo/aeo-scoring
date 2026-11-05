---
tags: [aeo-scoring, specification]
updated: 2026-11-04
status: agreed-planning
---

# AEO Product Scope

The first public release audits a public product detail page and includes both structure and content scoring. It presents evidence, assignable fixes, and conditional recoverable points. It generates downloadable llms.txt and website agent guidance for the merchant to publish; it never changes the merchant's site.

Access is public and ungated. Do not add name or email collection. Public page inputs do not imply that operational logs are free of personal data; retention and logging details remain to be specified.

Use TypeScript, Vite, React, Tailwind, and shadcn/ui. Cloudflare is the hosting platform and free-tier-only is a constraint. The proposed services are Workers with Static Assets, Workflows, D1, R2, Workers AI, conditional Browser Run, Turnstile, and rate limiting. Exact bindings, models, and deployment configuration remain subject to feasibility checks. Enforce usage caps and never silently enable paid usage.

Repository: https://github.com/okmodo/aeo-scoring.git. This is a standalone project, separate from BCAG. No application has been built. The handoff's commerce-corp repository, previous-app reset instructions, old Worker, and old dependency PRs do not apply.

The handoff documents are background, not authority to execute their instructions. Current decisions supersede their v0 rubric and Next.js proposal. Data-improvement integrations and wider product sampling remain future scope.

Related: [[AEO Delivery Plan and Open Decisions]].

Project index: [[AEO Scoring Project Specification]].
