# Revised S1 and S2 — rubric 2.0.0

This is a backend-only implementation of the approved proposal. S1 measures initial source delivery, text representation, product scope, configuration association and supporting-content access. S2 measures structured syntax, Product association, Offer connections and fields, identifiers and variant-family relationships. S3 compares representations; Content assesses shopper completeness. The numerical weights are project choices, not external certification requirements.

S1 remains 13 points, S2 remains 9, Structure 40 and Content 60. Full credit is 1, partial 0.5 and confirmed failure 0 for every revised subcheck. A failed or incomplete inspection is unmeasured and keeps its weight. No final score is produced with an unmeasured applicable check. An exclusion requires its named rule, reason and source evidence. Excluded weight is redistributed proportionally only within the criterion; a wholly excluded criterion cannot produce a final score.

## S1 — 13 points

| Subcheck | Points | Full | Partial | Zero | Applicability |
|---|---:|---|---|---|---|
| S1.delivery | 4 | Substantive main-product content is delivered in the initial HTML without JavaScript execution or interaction. | Some substantive content is delivered, while observed substantive sections require execution or interaction. | Complete successful inspection establishes no substantive initial product content. | Always applicable to a supported product-page audit. |
| S1.readability | 3 | Delivered product information is ordinary extractable text. | Some information is readable while other observed substantive information is image-only or opaque state data. | Established product information has no ordinary extractable text representation. | Always applicable to a supported product-page audit. |
| S1.scope | 3 | The audited product content is distinguishable from navigation, recommendations, reviews and other products. | Observed product boundaries are identifiable but partly ambiguous. | Complete inspection establishes mixed content with no reliable distinction of the audited product. | Always applicable; missing inspection is unmeasured, not an exclusion. |
| S1.configuration | 2 | Displayed values are reliably associated with the selected configuration. | A configuration is identified but some displayed-value associations are ambiguous. | Multiple configurations are established with no reliable selection/value association or a confirmed wrong association. | Exclude only with explicit evidence of exactly one configuration and no configuration-dependent values. |
| S1.supporting-access | 1 | Referenced specifications, guides and policies are accessible as readable sections or usable links. | Some references are readable and others are confirmed broken or inaccessible. | References exist but none provides accessible readable content; failures are confirmed. | Exclude only when complete inspection establishes no supporting references, including referenced sections. |

## S2 — 9 points

| Subcheck | Points | Full | Partial | Zero | Applicability |
|---|---:|---|---|---|---|
| S2.syntax | 2 | Relevant product markup parses and uses recognized types, properties and value formats. | Some markup is usable but established errors leave part uninterpretable. | Complete inspection establishes no relevant markup or only malformed or uninterpretable markup. | Always applicable to a supported product-page audit. |
| S2.entity | 2 | A Product entity unambiguously represents the audited product page. | An observed plausible Product has ambiguous page association. | Complete inspection establishes no Product or only entities demonstrably describing another product. | Always applicable to a supported product-page audit. |
| S2.offer | 2 | Offers connect to the appropriate Product or variant with internally coherent price, currency and availability fields. | Observed Offer information or association is usable but incomplete or ambiguous. | A merchant product has no associated structured Offer, a confirmed wrong connection, or unusable materially contradictory internal information. | Always applicable under current merchant categories; out-of-stock is not an exclusion. |
| S2.identifiers | 2 | Applicable external identifiers have valid formats and correct product or variant associations. | Useful but incomplete identifier evidence, including merchant SKU alone. | Supplied identifiers are demonstrably invalid or incorrectly assigned, or an established assigned applicable identifier is missing. | Exclude only with reliable explicit no-assignment evidence and no supplied external identifier requiring validation. |
| S2.variants | 1 | Parent products, variants and their distinguishing attributes are correctly connected. | Some observed variant relationships are established but others are incomplete or ambiguous. | Established variants have absent, incorrect or unusable structured family relationships. | Exclude only when source evidence explicitly establishes no variants; missing markup alone is insufficient. |

## Versioning and compatibility

The default `scoreAudit` produces rubric and engine 2.0.0. Service cache identities include both versions, for calibrated AI and uncalibrated fallback reports; no older cached score can satisfy the new key. Clients cannot request the internal legacy scorer. The API remains version 1 with the same report shape and forty checks. Source IDs S1.1–S1.5 map to `delivery`, `readability`, `scope`, `configuration`, `supporting-access`; S2.1–S2.5 map to `syntax`, `entity`, `offer`, `identifiers`, `variants`.

`scoreAuditV1` explicitly replays historical rubric 1 results. Existing v1 tests retain their assertions and recorded fixtures. Historical R13/R14 comparator tests use the existing exact `synthetic-cases.json` snapshots rather than regenerating their source objects with a newer extractor. Their source/request binding, mandatory facts and adversarial comparisons remain intact. Current v2 extraction, arithmetic, cache, report and unchanged-criterion isolation tests run separately in the normal feasibility suite.

The v2 complete example uses the existing independently reviewed semantic judgment fixture, plus explicit source statements of no external identifier assignment and no configuration-dependent values. Its content fit judgment remains 0.5, so Content 58.125 plus Structure 20 totals 78.125; this is a different fixture from the previously validated 80.0 report. Those original fixtures and runtime results have not been changed. The new example is independently reviewed before acceptance.

## Evidence and implementation limits

Every confirmed deduction and exclusion retains source evidence. Configuration exclusions cannot override contradictory controls or variant evidence. Merchant pages keep Offer applicable, including out-of-stock items. Missing external identifiers without established assignment remain unmeasured; a supplied invalid identifier remains a failure. SKU alone is partial. Variant-family modeling is independent of whether every child has an Offer; those connections belong in S2.offer.

Initial source inspection does not claim browser rendering or computed visibility. Opaque state containers do not by themselves prove what product information they contain. Deferred delivery, informational images and no-identifier statements use explicit supported source markers; unsupported wording remains unmeasured. Referenced support may be inline or linked. The existing policy retriever does not preserve an HTTP failure status, so its generic failed fetch cannot establish a broken link; it remains unknown. Confirmed 404/410 or explicit login evidence can establish inaccessibility when present. Unknown structured vocabularies, unresolved graph references, AggregateOffer and unsupported price specifications remain unmeasured rather than being assumed invalid. Processing retains existing extraction size/count limits; no live CPU measurement is claimed.

The frontend still imports rubric v1 for its full-credit explanatory copy. It can render the unchanged report shape and check IDs, but its owner must add version-aware explanatory copy before a coordinated rubric v2 UI rollout. This PR does not change presentation files, shared types or dependencies. Existing S2 identifiers reuse their IDs with changed meaning, so explanatory copy must follow report.rubricVersion rather than assuming v1.

No Cloudflare service or configuration changes, deployment, model call or merge are included. The existing 60% allowance limits, 1,000 ms CPU cap, account admission, selected model and password protection remain unchanged. Robots policy remains a nonblocking signal.

## Primary references

The relationship model follows Schema.org [Product](https://schema.org/Product) and [Offer](https://schema.org/Offer). Google documents [variant families](https://developers.google.com/search/docs/appearance/structured-data/product-variants) and the distinction between initial source processing and [JavaScript rendering](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics). These references inform practices, not this project's points or universal AEO eligibility.
