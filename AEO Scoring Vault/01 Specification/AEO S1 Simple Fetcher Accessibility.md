---
tags: [aeo-scoring, specification]
updated: 2026-11-04
status: agreed-planning
---

# AEO S1 Simple Fetcher Accessibility

S1 allocates 13 points to readable product content available to agents with different retrieval capabilities.

| Subcheck | Points |
|---|---:|
| Product name, model, selected variant | 2 |
| Meaningful product description | 3 |
| Relevant specifications | 3 |
| Price and currency | 3 |
| Availability | 2 |

For each item, award full credit when present as readable product content in initial HTML; half when available only after ordinary browser rendering; zero when unavailable, confined to an application-state blob, or fetched only after interaction. A failed rendering check is unmeasured, not evidence of absence.

Collapsed content qualifies for full credit when its text is already present in initial HTML. JSON-LD is assessed under S2 and does not replace readable page content here. An application-state blob alone earns no S1 content credit.

For specifications, apply the delivery rule to each applicable category attribute and average its credit. Missing attributes receive zero; C2 separately measures their content completeness. This is a deliberate distinction between delivery and information coverage, not a second copy of the same content check.

Google's rendering ability does not establish equivalent behavior for every agent. Initial HTML receives preference for broader compatibility.

Related: [[AEO C2 Attribute Completeness]] · [[AEO Sources and Evidence Classes]].

Project index: [[AEO Scoring Project Specification]].
