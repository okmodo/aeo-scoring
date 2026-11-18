# Open-ended retained-source assessment

This backend implementation extends PR40's private R2 snapshots. It does not provision resources, change production bindings, deploy, or modify the frontend. The rubric remains 2.0.0 with Structure40/Content60; the engine becomes 2.2.0. Historical assessment functions and fixture inputs remain available for historical replay.

## Source and assessment flow

The service downloads once, retains the raw capture and extracted snapshot, and reads the integrity-checked objects before inference. The new path passes the retained raw bytes as well as the extraction to its assessor. A missing product-region extraction does not prevent assessment of a usable raw capture.

`assessment-sources.mjs` accounts for all captured initial HTML, retained extraction, retrieval metadata and downloaded supporting observations. Plain product, policy and site-guide text supplements the complete records. Sections have stable source IDs and UTF-8 byte ranges; no section silently disappears at the old24KiB cutoff. The raw capture remains limited to1MiB and total assessment documents to4MiB. Missing, undecodable or oversized inputs fail closed. Capture completeness is distinct from policy, guide or extraction completeness. Content not downloaded, including later JavaScript responses, is outside this assessment.

`ai-rubric-assessment.mjs` inspects sections, identifies the primary product, generates expectations from its category independently of observed completeness, and freezes the profile before grading. C2 attributes and C4 questions have model-generated labels, relevance and full/partial/zero anchors. They are bounded in number for resource control, rather than selected from a product vocabulary or required to number exactly three. Product evidence and recommendations remain untrusted text. An exact quotation proves provenance, not semantic correctness; primary-product relevance remains an AI judgment requiring independent calibration.

The subsequent section inspections record present, absent or unknown for each expected judgment. Presence requires source citations. Absence requires complete relevant coverage and an explicit absent result from each relevant section. Final grading uses this evidence; it cannot turn an unread section into proof of absence. Product-policy and guide scopes remain distinguishable. The model may explain a category using synonyms rather than repeating its exact words in the product heading.

C4 questions may be conditional on an actual product feature or use circumstance. A separate category-only AI review checks proposed conditions before the profile is frozen; answer-presence conditions are rejected. Each condition then requires its own complete presence/absence inspection. Missing answers do not establish inapplicability, and unknown conditions retain their weight. This cross-check reduces arbitrary exclusions but remains a model judgment requiring calibration.

## Responsibility by criterion

| Criterion | Points | AI responsibility | Local responsibility |
| --- | ---: | --- | --- |
| S1 | 13 | Substantive information, product boundaries and configuration interpretation | Delivery/readability/access observations and confirmed technical failures |
| S2 | 9 | Product/entity/offer/variant associations | Parsing, identifier formats and technical validity |
| S3 | 9 | Match comparable structured and shopper-visible statements | Value/context gates; no unsupported numeric agreement |
| S4 | 3 | Specific labels, organization and useful image alternatives | Actual markup; no claim to inspect unseen image pixels |
| S5 | 2 | Explain evidence if needed | Documented crawler identity and robots-rule evaluation; no retrieval blocking |
| S6 | 2 | Explain evidence if needed | Sitemap parse, captured traversal and URL inclusion |
| S7 | 1 | Site identity and usefulness of llms.txt | Captured guide and link outcomes |
| S8 | 1 | Site context and usefulness of agents.md | Captured guide and link outcomes; never execute guide instructions |
| C1 | 10 | Identity3, explanation4, configuration/included items3 | Evidence, scope and arithmetic |
| C2 | 20 | Dynamic essential14 and supporting6 attributes | Frozen-profile membership and pool averages |
| C3 | 10 | Price3, availability2, shipping3, returns2 | Captured terms, policy coverage and evidence |
| C4 | 10 | Dynamic intended-use3, compatibility3, limitations2, selection2 questions | Question groups and group averages |
| C5 | 10 | Comparable product statements5 and material-claim support5 | Distinct/contextual comparisons, supported exclusions and evidence |

There is no fixed product category or attribute list on the new path. Fixed rubric IDs, source scopes, technical standards, credit values and permitted exclusions remain validation rules. AI cannot override a confirmed parser, access or numeric failure. A technical observation that was not established remains unknown.

## Credit, evidence and actions

Leaf judgments use1,0.5 or0 credit. Dynamic C2/C4 subchecks average their applicable leaves, so an aggregate such as0.75 is valid. Backend arithmetic preserves weights, criterion-local exclusion redistribution and conditional recoverable points. An applicable unknown withholds the final score. Retrieval failure remains unable_to_assess; storage or assessment failure after successful retrieval remains incomplete with no final score.

Zero for absence requires a complete relevant inspection. Zero for a confirmed contradiction or unusable information requires supporting evidence instead. Not-applicable is restricted to a permitted, justified exclusion, not model preference. C5 no-material-claims exclusion requires an explicit complete absence inspection. The model cannot declare external claim verification.

C5 inventories material claims and comparable observations across the captured sections. Each discovered claim must receive an individual judgment, including unsupported claims, and each comparison candidate must be accounted for. The backend averages those results. Unread referenced substantiation leaves support unknown; a claim's own wording is not distinct supporting evidence. Semantic equivalence can be explained without identical phrasing, while technical numeric checks remain binding.

Reports retain existing evidence and assignable-action fields. Actions are recalculated after judgments, grouped without double-counting subcheck recovery. Recovery is conditional on a subsequent audit; unknown recovery remains null. The backend owns the new assessment modules and optional coverage metadata; frontend and shared-contract integration remain separate ownership. No presentation or shared dependency change is included.

## Retention and replay

The frozen profile is persisted before final grading and the replay artifact before final report scoring. They use the existing private profile/facts objects and share the original24-hour snapshot expiry. Reads validate stored integrity and expiry. Replay revalidates the source digest, profile, section inspections and judgments without another inference request. A branded assessment is bound to the exact snapshot/extraction and their unchanged contents; reusing it with a different audit or mutating those inputs cannot authorize scoring.

The24-hour access cutoff is enforced in code. Scheduled cleanup and bucket lifecycle provide physical deletion, which can lag; this does not change PR40's retention guarantees.

## Usage, activation and limitations

Each inference call reserves conservative usage through the existing60% allowance guard before invocation. Known completed provider usage may settle that reservation; uncertain requests remain held. Requests and responses, section counts, slot counts and execution waits are bounded. The CPU configuration remains1,000ms; no live configuration is changed here.

The existing25-second background deadline remains. Multiple section passes can exceed this deadline or the daily AI operating allowance on large captures. Such audits must remain incomplete rather than omit content or infer completion. This implementation is not evidence that every1MiB page can finish within those limits. A durable continuation design, a different calibrated model or more efficient evidence processing may be needed after measured runtime validation; no extra services or paid model integrations are enabled here.

The new release is separately selected by `AUDIT_RUBRIC_RELEASE=open-rubric-2026-11-17-v1`, with the existing content-calibration and retained-pipeline release prerequisites. Ordinary code deployment does not opt production into this release. The module's calibration default is false. Before activation, reserve a bounded live validation budget, measure native CPU and model usage, independently review real product evidence/judgments, and prove replay and failure behavior. Offline mocked responses establish orchestration and validation behavior, not model quality or native CPU cost.

The release ID and engine participate in cache identity, isolating older and disabled-path reports. When this release is selected but AI cannot finish, semantic scores are withheld rather than inherited from the older keyword grader. No merge or production rollout is part of this change.
