# Product extraction and scoring engine

The backend owns retrieval, evidence, rubric arithmetic, category rules, inference admission, storage and the version 1 response contract. Frontend presentation and its adapter remain separately owned. This change does not merge or deploy code.

## Evidence pipeline

The isolated public Worker uses its existing public-only egress and validates every product redirect. Retrieval shares an eight-second deadline. Product HTML streams through Cloudflare's native HTMLRewriter with a 1 MiB input limit. The accumulator selects a main or explicit product region and excludes hidden ancestors, script state, navigation, related products and templates. It retains bounded paragraphs, leaf text, headings, images, links, selected controls and explicitly marked current/previous prices. CSS-dependent visibility remains unknown. Neither a stylesheet nor an executable script alone makes otherwise readable HTML unusable.

The native accumulator retains at most 300 observations per collection, 8,192 characters per retained text item, 262,144 retained text characters, 30,000 elements and depth 200. Reaching a relevant bound withholds absence findings. JSON-LD has separate 131,072-character per-script and 262,144-character aggregate allowances, up to 100 retained scripts. Malformed JSON is never repaired into evidence. Product microdata and RDFa are detected but currently prevent a claim that unsupported markup is absent.

Robots is optional evidence and discovery input, never permission to audit. Its request is capped at 64 KiB and 500 ms. Sitemap inspection uses at most two same-origin requests, 32 KiB each, within 750 ms. Three fixed guide probes share 500 ms and 8 KiB per file. At most two same-origin linked shipping/returns pages share 750 ms and 128 KiB per response. Supporting requests do not follow redirects or execute instructions. Missing default files, failed requests, unfinished sitemap indexes and verified listings remain distinct observations.

## Assessment rules

The configured rubric remains Structure /40 and Content /60. All 40 check IDs have an assessment path. `config/categories.v1.2.json` retains the three existing templates and adds explicit editorial templates for handbags and personal flotation devices. Category inference requires a recognizable product heading. Unsupported categories remain incomplete.

Initial source HTML and supported JSON-LD provide deterministic observations. A completed parse does not prove that every unfamiliar sentence is irrelevant. Unrecognized semantic representations remain unknown instead of becoming zero-point deductions. The content judge receives the full and partial anchors, category attributes and questions, product context, parsed price roles and selected controls, and bounded source excerpts. It returns individual judgments rather than scores. C2 and C4 averages and all numerical points are calculated by application code.

The proposed semantic model is `@cf/openai/gpt-oss-120b`, pinned rather than automatically substituted. The request uses the Responses API with low reasoning and structured output, at most 3,072 output tokens, no streaming and no retries. Evidence input is capped at 24 KiB and the complete request is bounded. The transport asks for canonical observation IDs instead of generated quotations, then maps those IDs back to original text and source locations. Complete-scope exclusions record a derived absence inspection rather than pretending absence is a quoted sentence. Exact source IDs and passages, policy scope, category conditions, full-price currency/context and comparable consistency quotations are checked before findings can reach scoring. Those checks establish provenance and structural constraints. Model interpretation still requires calibration; they do not prove semantic truth or independently verify merchant claims.

The live calibration record is in `evals/changes/complete-scoring-engine/calibration-review.md`. Semantic scoring is disabled by `SEMANTIC_CALIBRATION_APPROVED = false` until an independent review establishes an acceptable calibration. An AI binding alone cannot enable it. The release status must follow the actual calibration outcome. A failed or unavailable judge leaves unresolved checks unmeasured. It must never manufacture a numerical final score.

## Free-tier inference budget

`semantic_budget` is an additive table in the project's D1 schema. Apply that schema to the project's database only when an authorized release is performed. An atomic reservation caps this application's inference reservations at 8,000 neurons per UTC day. Each request reserves a conservative estimate using UTF-8 input bytes, output limits, pricing of 31,818 input / 68,182 output neurons per million tokens, and framing headroom. Failed, invalid and timed-out requests retain their reservations. There is no paid fallback, automatic model substitution or quota reset. Reservations from old days are pruned after two days.

The account was identified by the user as Workers Free. Cloudflare's account-wide allowance is 10,000 neurons per day; other applications can consume it, so this application's cap does not guarantee remaining account allowance. The provider's Free hard stop remains the final billing boundary. No paid plan, gateway credits or unrelated services are configured. A missing AI binding, unavailable budget table, exhausted allowance or model failure yields a partial report with an explicit limitation.

An inference invocation has a 20-second response deadline and one call maximum. The binding has no cancellation primitive, so a timed-out provider call can continue, retaining its budget reservation. Together with the eight-second retrieval deadline this leaves headroom inside the 30-second background-extension window. The existing audit lease remains 60 seconds. Cache keys distinguish semantic-enabled and deterministic-only audits and include the scoring/category versions.

## Reports and actions

A final score appears only when all applicable checks are measured and a category is supported. Excluded subchecks redistribute points only inside their criterion. `availablePoints` records a subcheck's effective weight after redistribution; `maxPoints` retains the published nominal rubric weight. Per-attribute, question, comparison and policy evidence remains attached through evidence IDs. Incomplete evidence can have known findings and a partial earned subtotal, never a scaled final score.

Actions group affected checks under an assignable owner. Known conditional recovery is ranked descending; unresolved assessment work follows it with null recovery. Recovery uses the same within-criterion redistribution as scoring. An affected subcheck belongs to one action, preventing numerical double counting. Changes may share implementation work across actions; actual recovery requires a new audit in the same product context.

## Verification and release boundaries

Frozen synthetic HTML, extracted evidence and response cases live in `backend/fixtures/complete-engine`. Native-runtime replay uses `backend/engine-runtime-worker.mjs` as a local-only entry point. It has no deployment configuration and no production bindings. The Kokatat replay uses a captured public HTML document stored outside the repository; full merchant HTML and embedded session data are not committed.

Local workerd replay verifies native callbacks and the real product extraction. It does not measure production CPU time. A production-like Free CPU measurement remains a release check; source-only architecture and smaller parser overhead are not proof of the 10 ms request CPU ceiling. No Cloudflare service is deployed by these tests or ordinary CI.

References: [HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [JSON mode](https://developers.cloudflare.com/workers-ai/features/json-mode/), [structured-data policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies).

## Independently adjudicated full-report example

`contracts/v1/examples/assessment-engine-complete.json` is generated from the synthetic shirt HTML and the separately reviewed judgments. The expected total is 78.125, with Structure 20 and Content 58.125. Basic fit labeling earns half credit because it does not explain the cut. Single configuration, absent conditional fabric claims and absent material claims receive the explicitly permitted exclusions. This freezes a complete arithmetic path and frontend contract example, not a claim that live automatic semantic scoring is calibrated.

## Replaying without deployment

After installing the root and backend locked dependencies, run:

```sh
node backend/replay-engine.mjs backend/fixtures/complete-engine/complete-shirt.html https://shop.example/products/everyday-tshirt --support backend/fixtures/complete-engine/support.json --judgments backend/fixtures/complete-engine/reviewed-judgments.json
```

Omit `--judgments` for deterministic evidence only. The command compiles a local-only worker, runs workerd and prints a bounded summary. `--output <path>` explicitly saves extracted test evidence and the report. It makes no merchant, model, database or deployment requests. A local loopback listener is required. This is a test harness, never a public API entry point.
