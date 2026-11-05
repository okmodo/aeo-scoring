---
tags: [aeo-scoring, specification]
updated: 2026-11-04
status: agreed-planning
---

# AEO S5 Robots Access Policy

S5 allocates 2 points to effective robots access at the audited product URL, not merely file existence.

| Subcheck | Points |
|---|---:|
| Googlebot and Bingbot access | 1 |
| AI retrieval crawler access | 1 |

Googlebot and Bingbot receive 0.5 each. Split the AI allocation equally across a published, versioned list of retrieval crawlers. Each receives its allocation when allowed and zero when explicitly disallowed. Apply the effective user-agent group and path rules, including applicable crawler-specific behavior.

A missing robots.txt is not automatically a failure. Interpret status codes and errors according to documented crawler behavior; unresolved retrieval failures are unmeasured. Do not infer permission from an unparseable or inaccessible response.

Training-only restrictions cause no deduction. Handle user-triggered fetchers separately according to documented behavior rather than assume every agent observes identical rules. Do not treat Crawl-delay as Disallow.

Record per-crawler rules and outcomes. Spoofed user-agent fetches only show our observed test result. They do not prove access for the real crawler, which may have different IP verification or behavior.

Confirmed restrictions receive prominent access warnings as well as their S5 scoring treatment, without another numerical penalty. Ask whether policy is intentional before recommending removal.

Related: [[AEO Access and Eligibility]] · [[AEO Priority Ranking]].

Project index: [[AEO Scoring Project Specification]].
