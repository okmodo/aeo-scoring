# Deterministic scoring coverage

The audit measures up to six of the existing rubric subchecks from bounded raw evidence. The v1 response shape and Structure /40 and Content /60 weights stay the same.

- **Product markup.** Entity and core properties retain their existing rules. Offer and identifier scoring requires a unique Product record explicitly associated with the audited URL. A single unqualified Offer can earn separate credit for a valid price and recognized currency together, and for recognized availability. Aggregate, conflicting or insufficiently scoped offers remain unmeasured. Brand plus a format-checked GTIN or a declared manufacturer part number earns full identifier credit. Merchant SKU receives half the identifier component. This checks supplied markup, without verifying product registry ownership or stock.
- **Crawler policy.** The final URL's successfully parsed robots policy is evaluated for the versioned search and AI retrieval groups. Each crawler has equal weight within its group. A group remains unmeasured when any member's result is unresolved. Training and user-triggered crawlers are outside the score. The evidence describes policy at the audited path and cannot establish successful requests from each crawler.
- **Reports.** Measured checks link to derived source evidence. Proposed fixes show conditional points only for the subchecks they cover. The current implementation keeps the final score absent when applicable checks are unmeasured. Content semantics, broader structure and variant checks remain pending. The cache namespace changes for new submissions while existing report links retain their recorded results.

These checks reuse the fetched page and final robots policy. They add no network requests, inference services or shared dependencies. The change is validated offline and packaged for Workers Free. Hosted CPU and representative scoring accuracy remain separate validation steps.

[Google Product structured data](https://developers.google.com/search/docs/appearance/structured-data/product-snippet) · [Schema.org Offer](https://schema.org/Offer) · [Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html)
