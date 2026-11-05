---
tags: [aeo-scoring, specification]
updated: 2026-11-04
status: agreed-planning
---

# AEO S2 Product Structured Data

S2 allocates 9 points.

| Subcheck | Points | Full credit |
|---|---:|---|
| Product entity | 2 | Parseable entity associated with audited product |
| Core properties | 2 | Meaningful name, description, image; equally weighted |
| Offer information | 2 | Price and currency together 1; availability 1 |
| Identifiers | 2 | Brand 1; appropriate product identifier 1 |
| Variant relationships | 1 | Variants and offers distinguishable and correctly associated |

A parseable entity with ambiguous page association earns half of entity points. Accept recognized JSON-LD, microdata, and RDFa. Malformed markup earns no credit for properties that cannot be reliably extracted.

Accept valid GTINs or appropriate manufacturer identifiers. A merchant SKU alone earns half of the product-identifier point. Do not require identifiers that do not apply under category rules. Truly single-configuration products exclude variant relationships.

Markup delivered only after rendering earns half of otherwise eligible credit. Apply the common full/half/zero anchors before that delivery multiplier. Pin supported schema-validation rules in the rubric configuration.

Product markup supports documented shopping features; it is not a universal requirement for AI inclusion.

Related: [[AEO S3 Markup Agreement]] · [[AEO Scoring Contract]].

Project index: [[AEO Scoring Project Specification]].
