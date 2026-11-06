# Selected variant scoring

The audit can score a bounded inline schema.org ProductGroup from raw JSON-LD. The supported form has two to eight Product members and explicitly declares how they vary by color, size, material or pattern. The observed combinations and URLs must be distinct. Each member must have a nested Offer whose URL identifies that same member and contains at least one verified offer component. The selected member must match the final audited URL exactly after URL parsing.

This adds credit for the S2 variant relationship. The existing offer and identifier checks can then use fields from the selected member. A sibling's availability, currency or identifiers cannot supply credit for the selected variant. The response can show the selected variant's declared dimensions as bounded plain text. A structured association does not establish the rendered selection or current stock.

Unsupported contexts, conflicting links, multiple candidate groups, aggregate offers, reference-only members and incomplete extraction remain unmeasured. The check does not infer that a product has one configuration when variant evidence is missing. The v1 response, scoring weights and incomplete-assessment rules stay in place.

The implementation reuses the existing JSON-LD limits, requires no extra requests, and changes the cache namespace for new submissions. Existing report links keep their recorded results. Hosted CPU and merchant coverage remain unverified for this increment.

[Google Product variant structured data](https://developers.google.com/search/docs/appearance/structured-data/product-variants) · [Schema.org ProductGroup](https://schema.org/ProductGroup)
