---
tags: [aeo-scoring, specification]
updated: 2026-11-04
status: agreed-planning
---

# AEO Recovery Examples

These are synthetic arithmetic examples, not live audit findings.

| Action | Before | After specified fix | Recovery |
|---|---:|---:|---:|
| Render existing specifications in initial HTML | S1 specifications 1.5/3 | 3/3 | +1.5 |
| Complete shipping guidance | C3 shipping 1.5/3 | 3/3 | +1.5 |
| Add missing price and currency to otherwise valid raw Offer markup | S2 price/currency 0/1 | 1/1 | +1 |

Rendering existing specifications earns no extra C2 completeness points if those values already qualified as rendered shopper-visible content. Other affected checks can be included only when separately evidenced.

Overlap example: adding missing price/currency could recover 1 Offer point, while adding price/currency and availability could recover 2. Combined recovery is 2, not 3. Merge the actions or show the smaller one as an alternative.

Dependency example: sourcing and publishing new attributes could jointly recover 4 category-checklist points. Neither catalog-only sourcing nor an empty display template earns those 4 independently. Show the shared conditional gain after both steps.

Example action card: Add delivery guidance to shipping policy; owner Site operations; current C3 shipping 1.5/3; potential recovery +1.5; condition publish applicable dispatch/delivery guidance and material conditions; evidence policy URL and excerpt. Never invent delivery times.

Related: [[AEO Assignable Fixes]] · [[AEO Recovery Calculation]].

Project index: [[AEO Scoring Project Specification]].
