# Retained AI pipeline

## Private snapshots and retention

The bounded product response is captured as it passes through the same stream used for extraction. The cap is 1 MiB; a size- or time-limited response remains marked incomplete. Optional supporting pages are represented by their bounded extracted evidence in the snapshot, rather than separately retained HTML. The extracted snapshot and raw product bytes are separate private R2 Standard objects, with a D1 manifest keyed by audit ID. The manifest records their sizes and SHA-256 digests; reads verify both objects, their bounds and their integrity. Access must remain through the Worker binding, never a public bucket or public object URL.

The manifest is created before either object is written, and only becomes ready after both writes. The validated profile and facts are persisted in separate immutable private objects, with manifest claims before their writes. They share the snapshot expiry; profile is capped at 32 KiB and facts at 256 KiB. Reads verify each object’s size and digest before replay. A failed write leaves a pending manifest for cleanup. Reusing an audit ID cannot overwrite a previous manifest. Reads reject snapshots at or after 24 hours from creation, including when they expire during a read. Scheduled cleanup must invoke the bounded cleanup method under a separate Workers/D1 budget reservation; cleanup removes objects before the manifest and is safe to retry. It processes at most 100 manifests per call and stops on failure. The scheduler and private bucket binding must be configured before this feature is enabled.

A bucket lifecycle expiration rule is a fallback for orphaned objects, not a precise deletion guarantee. Cloudflare says expired objects are typically removed within 24 hours of their expiration time and may take longer. Physical deletion can therefore lag the 24-hour access cutoff, especially if cleanup or lifecycle processing is delayed. A one-day lifecycle rule must be configured separately; the code alone does not configure or verify it. See [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

Each write or read reserves conservative R2 usage before touching objects. A successful operation settles its reservation; failed or uncertain operations retain their reservation until reconciled. Standard R2 includes 10 GB-month, 1 million Class A operations and 10 million Class B operations per month; the shared 60% operating limits are 6 GB-month, 600,000 and 6 million respectively. The storage reservation uses the full object size conservatively, rather than assuming deletion will occur promptly. Delete operations are free according to [R2 pricing](https://developers.cloudflare.com/r2/pricing/); cleanup reserves Workers and D1 capacity separately and does not require R2 operation headroom. These are account-wide limits and application counters alone cannot guarantee billing safety.

## Assessment stages and replay

The Worker submits the stored extraction to the existing Workers AI model (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`). It first requests an open-ended category with exact product evidence, then requests three essential and three supporting attributes from the category label alone. This second request does not receive the page's observed attributes or completeness. The generated profile is validated, frozen, and saved privately before the fact extraction call starts. Recognized category labels retain the existing detailed attribute anchors. Open categories use three slots per attribute pool and four always-applicable decision-support questions, without changing the rubric's weights. Profiles cannot create certifications or exclude checks arbitrarily.

Open attribute grading is deliberately conservative: complete recognized fiber percentages, selected size codes, and measurements with appropriate units have full-credit anchors; useful but incomplete labelled values earn partial credit. Ambiguous values remain unmeasured. Model-selected category relevance and attribute relevance remain semantic judgments; spelling, evidence, structure and duplicate checks cannot prove every judgment correct. Live calibration of this new orchestration is outstanding. Never describe the older release's calibration as validating these new stages.

The shared background deadline is 25 seconds from the beginning of retrieval. AI stages check remaining time before issuing work. The deadline prevents starting later calls without time remaining; an AI call already issued cannot be cancelled through the binding, and its reservation remains if usage cannot be established. This is separate from the unchanged 1,000 ms CPU cap. A slow page/storage/model may still produce an incomplete report. This PR does not introduce a Queue or durable background job.

Successful fact extraction saves a private replay artifact containing the frozen profile and bounded model responses. `readAssessment(auditId)` verifies its manifest digest and expiry. `replayContentAssessment({snapshot,extracted,report,artifact})` reconstructs source observations, revalidates the profile and model evidence, and returns facts usable by `scoreAudit(..., {validatedFacts:facts,categoryProfile})` without another inference call. Replay requires the same engine revision and retained inputs; it is available for 24 hours, not permanent archival. The profile checkpoint can be inspected if facts fail. Automatic resumption and a public retry endpoint are not added.

All four private objects (`html`, `snapshot`, `profile`, `facts`) share the snapshot's original expiration. The raw capture is bounded to 1 MiB, extracted snapshot to 2 MiB, profile to 32 KiB, and replay facts to 256 KiB. An input that exceeds the capture or extraction limits remains incomplete. This work does not turn truncated inspection into evidence of absence.

## Proposed additive service contract

Existing `/api/v1/audits` submission and status response fields and status meanings are preserved. Rubric remains `2.0.0`; engine becomes `2.1.0`. Cache identity includes the engine and `retained-ai-1` pipeline so older reports cannot masquerade as newly processed results. The backend owns these additions. Frontend presentation and shared `contracts/` modules remain owned by the frontend/integration chat and have not been edited.

`report.category` and `report.coverage.category` may contain an open identifier such as `open:hiking-shorts`. This is a generated label identifier, not a closed vocabulary or an industry certification. Optional `report.coverage.categoryAssessment` contains `version`, human-readable `label`, `profileId`, and exact source `evidence` references (`sourceId`, `quote`, `url`, `location`). Optional `report.coverage.pipeline` contains `version: "retained-ai-1"` and an ordered `stages` array. Each stage has `stage` (`retrieval`, `snapshot`, `category`, `content`, `scoring`), `status` (`running`, `completed`, `failed`, `skipped`), `code` (stable safe diagnostic code), and `at` (Unix milliseconds). It never contains provider exceptions, credentials, or full downloaded pages. It is also saved privately in D1, including when retrieval produces no report.

For example, an ambiguous product produces the following diagnostic fragment within an incomplete report. The report still contains its measured checks and evidence, with `score: null`:

```json
{
  "status": "incomplete",
  "score": null,
  "coverage": {
    "pipeline": {
      "version": "retained-ai-1",
      "stages": [
        {"stage":"retrieval","status":"completed","code":"downloaded","at":1794873600000},
        {"stage":"snapshot","status":"completed","code":"snapshot_retained","at":1794873600010},
        {"stage":"category","status":"failed","code":"classification_ambiguous_category","at":1794873601000},
        {"stage":"content","status":"skipped","code":"category_unavailable","at":1794873601000},
        {"stage":"scoring","status":"completed","code":"report_incomplete","at":1794873601001}
      ]
    }
  }
}
```

A storage failure following successful retrieval yields `incomplete`, a null score, and `snapshot_unavailable`; it does not claim the merchant could not be retrieved. Retrieval failures remain `unable_to_assess` with no report or numerical score. Category preparation, budget admission, model execution, response validation and deadline failures retain distinct safe stage codes. Applicable checks without supported evidence remain unmeasured. Cached responses retain their original stage history and set the existing `cache.hit` field rather than rerunning the pipeline.

## Activation prerequisites and verification limits

No Cloudflare resources, bindings, secrets or deployment are changed by this PR. Before activation, create a dedicated **private Standard** bucket, add a one-day lifecycle deletion rule scoped to `retained/`, bind it as `AUDIT_SNAPSHOTS`, apply migrations `0003`, `0004`, and `0005` after the existing migrations, and set `AUDIT_PIPELINE_RELEASE=retained-ai-1` only after live validation is accepted. Keep the existing content release binding, password settings, usage token and CPU cap. Production admission requires the retained storage when AI is configured; absent storage cannot silently fall back to an unretained AI call.

Keep the existing hourly scheduled trigger. The scheduled handler reserves Workers/D1 usage before cleaning at most ten expired snapshots and 100 expired diagnostic records. If account usage cannot be verified or the 60% ceiling is exhausted, it stops; the bucket lifecycle remains the deletion fallback. DeleteObject operations are free and do not require Class A headroom. Cleanup throughput is intentionally bounded; lifecycle timing and delayed scheduled cleanup mean physical removal is not guaranteed at exactly 24 hours.

Read-only checks on November 17, 2026 verified account R2 metrics and GraphQL operation/storage query shapes after the user enabled R2. The private runtime usage token was also tested after its permissions were updated. No model calls, new native Worker CPU measurements, bucket writes, deployment or frontend modifications are part of this verification. Frozen offline scenarios validate orchestration and arithmetic; they do not establish real model quality, real-page completion, or native CPU cost.

Existing historical fixture inputs and rubric-v1 replay are preserved unchanged. The new engine's report metadata changes to `2.1.0`; the regression against the frozen `2.0.0` complete report explicitly expects only that metadata difference. Historical fixture replay is distinct from permanent storage of every public audit: individual page/profile/facts snapshots expire after 24 hours by design.

Local read-only page preparation on November 17 found Scarpa's boot response could prepare a category request without the prior T-shirt keyword gate. Faherty's shorts response reached the 1 MiB capture limit, so full inspection remains unproven. Kokatat returned HTTP 200 and its page title, but the local parser produced no usable product-region blocks; category preparation therefore lacked source evidence. No LLM was invoked for these checks. These outcomes do not constitute passing live model calibration or complete real-page reports.
