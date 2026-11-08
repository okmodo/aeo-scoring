# Bounded sitemap scoring

The public audit Worker can inspect same-origin XML sitemaps after successful product retrieval. It uses a robots.txt declaration or the conventional /sitemap.xml path, follows at most one index child, and never follows sitemap redirects or fetches listed product pages. Robots sitemap declarations provide discovery hints. Robots permissions do not control sitemap retrieval. The existing public-only egress boundary applies.

Inspection makes at most two extra requests, with a 32 KiB cap per response and a short shared deadline within the audit timeout. The XML parser accepts a bounded subset of the sitemap protocol and rejects malformed XML, custom entities and unsupported forms. Failure to inspect a sitemap leaves the product assessment intact.

S6 usability receives credit only when the inspection establishes a valid listing. S6 inclusion receives credit only for an exact final audited URL in a validated listing. Other cases remain unmeasured, including canonical-only matches, oversized documents, uninspected index children and missing entries. The observation records the inspected sitemap URL and the basis for the credit. This inspection does not prove indexation or evaluate every sitemap on a site.

The v1 response shape and rubric weights stay in place. Existing report links keep their recorded results. New submissions use a new scoring cache namespace. The frontend, dependencies and Cloudflare resource configuration are outside this change.

[Sitemap protocol](https://www.sitemaps.org/protocol.html) · [Google sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
