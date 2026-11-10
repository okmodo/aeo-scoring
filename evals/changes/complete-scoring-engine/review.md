# Independent technical review

**Status: Changes requested / draft only.** This review is not approval of a complete engine, model release, merge, or deployment. The request's outcomes O2 and O3 remain incomplete: the live semantic judge did not pass calibration and remains disabled; the independently adjudicated 78.125-point synthetic fixture verifies report arithmetic and evidence plumbing, not autonomous real-product scoring. The captured real-page experiments do not demonstrate a complete trustworthy report.

The plan was committed separately as `f74382a` before this implementation. The current production calibration gate is false; the optional inference path reserves a bounded daily budget before a request and retains the reservation on failure. Model trials and their limitations are recorded in `calibration-review.md`. No merge, deployment, or paid-service change was performed as part of this review. I did not independently inspect external account billing settings or prove the absence of changes outside the reviewed repository and observed calls.

The synthetic full-rubric regression checks 40 subchecks, exclusion redistribution, evidence references, conditional recovery, and the frozen service report. The targeted complete-engine, support and semantic-runner suites passed 19 tests during review. These tests do not replace the plan's full evaluation, hosted CI, or semantic calibration. C5 comparisons in deterministic content assessment now use shopper-visible evidence rather than duplicating structured-data conflicts.

Findings sent to the implementation owner and rechecked after correction:

1. Sitemap inspection marked itself complete upon finding one usable URL set even when additional declared maps remained uninspected or failed. This could award a false zero for product inclusion. Require complete inspection of the relevant declared maps and children before an absence deduction.
2. Structured/raw price and availability comparison treated null observations as absent, although null also represents ambiguity among multiple prices or stock states. Preserve unknown for ambiguous or unrecognized evidence; establish missing information separately.
3. An expired structured price forced the entire offer fraction to zero even when availability was valid. The rubric separately allocates one point to availability, so the latter must retain its point.

The final code preserves unknown when sitemap traversal is incomplete or raw comparison values are ambiguous, and gives the availability point for an expired price. The corresponding targeted regressions passed: 62 retrieval, complete-engine and product-fields tests. These findings are closed for the reviewed code, but the goal and calibration limitations above remain open.

The support-guide recheck found that external references are retained as unresolved, known broken sitemap references are not awarded full usability, and inspected catalog/help references are recognized. Real audits require retrieval to populate the inspected-reference data for those latter cases; otherwise the result remains unknown. The observation-ID semantic probe and earlier live attempts still contain substantive scoring errors and do not constitute model approval.

Full process review remains pending the final implementation commit, source-bound evaluation records, handoff, and hosted CI.

The final quick recheck covered recommendation-region exclusion, extraction element limits, the local replay harness and the recorded native evidence. The 16 targeted HTML extraction and semantic-transport tests passed; no new critical issue was found in that review. The implementation's native replay record distinguishes the independently adjudicated synthetic complete report from the incomplete real-page report and does not claim a production CPU measurement. An independent attempt to rerun the native fixture failed because this review runtime denied Miniflare's local `127.0.0.1` listener with `EPERM`; the native replay result therefore remains an implementation-run observation rather than an independently reproduced result. No model calls were made in this recheck.
