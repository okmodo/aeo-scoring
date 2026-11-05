---
tags: [aeo-scoring, specification]
updated: 2026-11-04
status: agreed-planning
---

# AEO Sources and Evidence Classes

Use three visible evidence classes: documented platform requirements, supported best practices, and emerging practices. Attribute each requirement to its platform/feature; do not universalize Google requirements to every bot. Numerical weights are editorial and should be published with rubric versions.

Primary sources consulted during planning:

- [Google AI features](https://developers.google.com/search/docs/appearance/ai-features): general SEO foundations; no special AI file or schema prerequisite for its AI search features.
- [Technical requirements](https://developers.google.com/search/docs/essentials/technical): crawl access, successful response, indexable content.
- [JavaScript processing](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics): Google can render; other agents must not be assumed equivalent.
- [Merchant listing structured data](https://developers.google.com/search/docs/appearance/structured-data/merchant-listing): product, offer, identifiers, variants, and policy information.
- [Structured-data policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies): accurate relevant markup consistent with displayed content.
- [Helpful content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content): comprehensive useful information and evidence of reliability.
- [Robots processing](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec): effective rules and status handling, specific to Google's documented behavior.
- [Sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview) and [sitemap construction](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap): discovery, canonical URLs, and freshness limits.
- [llms.txt proposal](https://llmstxt.org/): emerging practice; pin the evaluated proposal version.
- [AGENTS.md](https://agents.md/): coding-agent convention; a merchant website guide is our experimental extension.

There is no universally accepted industry-standard numerical AEO score established by these sources. Our page-readiness score differs from observed mentions/citations measured by visibility tools. Validate the rubric against outcomes later; do not imply that validation already exists.

Refresh source-specific crawler and protocol details before implementation. These references support practices, not our thresholds or allocations.

Related: [[AEO Scoring Contract]].

Project index: [[AEO Scoring Project Specification]].
