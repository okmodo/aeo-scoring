# Granite binary benchmark

The benchmark runs outside the audit Worker. It sends one question per selected rubric subcheck and one Granite request through the configured `default` gateway. The response schema requires a `results` object with every requested question ID as a key. Each value contains a binary answer, a reason up to 300 characters, and eligible evidence IDs. The result covers only the selected subchecks and uses their rubric v2 weights.

## Replay the frozen fixture

```sh
npm run test:granite-binary
node scripts/granite-binary-benchmark.mjs offline evals/fixtures/granite-binary-harness.json /tmp/granite-binary-fixture-result.json
```

Use a new output path. The CLI creates the file with owner-only permissions and declines to overwrite an existing result. The synthetic fixture covers grounded passes, unsupported stock status, and a zero supported by a complete shipping-policy inspection.

## Use a prepared capture

Build a private JSON input in the fixture format with one question per selected rubric ID. Use the latest hash-checked prepared capture and include only the parsed sources the operator has associated with the primary product. Each evidence entry supplies an exact source quote, its source ID and scope, and a field-specific kind from the parser or operator's verified classification.

A question can override the rubric's full-credit text with a category-specific pass rule. It lists eligible evidence IDs and up to two required evidence kinds. Use a distinct kind for a person modeling a product, a shipping heading, or a selected configuration's stock status. The harness verifies quotes and scopes and requires all the declared kinds for credit. This check relies on correct source selection and field labels when preparing the input. Reasons are model explanations. Inspect them for semantic errors separately from source and field checks.

A model `fail` earns zero only with eligible evidence of failure or an operator-verified absence backed by complete relevant sources. Set `verifiedAbsenceSourceIds` only after establishing the absence and checking the coverage of the cited sources. An unresolved check has no points and makes the benchmark score incomplete. An incomplete response still retains the other findings. The benchmark still reports measured findings and their earned points.

For a live calibration, use a private environment with the project account, Workers Paid subscription, and D1 usage ledger. The environment accepts `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_SUBSCRIPTION_ID`, `CLOUDFLARE_BILLING_READ_TOKEN`, `CLOUDFLARE_D1_API_TOKEN`, and `AUDIT_AI_GATEWAY_TOKEN`. An optional `AUDIT_AI_GATEWAY_READ_TOKEN` can read gateway metadata. Use the project's existing billing, D1, and inference permissions. The CLI pins the shared project D1 ledger so it sees the production reservations.

```sh
node --env-file=/private/path/granite-benchmark.env scripts/granite-binary-benchmark.mjs live /private/path/prepared-fixture.json /private/path/new-result.json
```

The live benchmark checks the existing shared usage ledger before sending any inference. It preserves the 60-second model timeout and current request and response bounds. The result records the serialized request size, time from sending the inference request to receiving HTTP headers, time spent in the model call including admission, total benchmark time, and provider-reported neurons when available. A timed-out inference keeps unknown usage. Live calibration writes usage bookkeeping to the existing ledger and saves the model output and verified findings to the private result path.

## Stored attempts and incomplete results

Migration `backend/migrations/0014-model-attempts.sql` adds `model_attempts` and `model_question_results`. The live CLI needs these tables in its existing project database before it can send an inference. The harness leaves deployment and migration rollout to a separate operation.

Each attempt stores the response bytes as base64 before scoring, with the model, stage, expected question IDs, capture hash, timing, and reported neurons. A timeout without a response stores a null body. Oversized or interrupted bodies retain the bytes received up to the existing 64 KiB limit with a truncation flag. The raw record preserves unexpected or invalid answers. Every expected question gets a normalized row. A missing, duplicate, or invalid answer has null points and an explicit validation status. Valid findings count independently, and the benchmark score remains null when the report is incomplete.

The attempt ID makes write retries idempotent. Attempts expire after 24 hours, and the CLI prunes one expired attempt with its questions at each admitted live run or offline replay. The live CLI keeps a private `.capture.json` fallback if D1 fails to save the result. Keep that file private and remove it after recovery. An interruption before response capture can leave a pending attempt.

Replay a previous result without contacting Cloudflare or Granite. Install the locked backend development dependencies to use its local D1 runtime.

```sh
npm --prefix backend ci --ignore-scripts --no-audit --no-fund
node scripts/granite-binary-benchmark.mjs replay /private/path/prepared-fixture.json /private/path/new-report.json /private/path/saved-result.json /private/path/local-d1
```

The local database distinguishes a saved model JSON object from a captured HTTP envelope. The replay reader accepts older array-shaped outputs and newer keyed outputs. Recorded request bytes take precedence over the reconstructed prompt size. Replay IDs include the normalizer’s request shape, so a schema upgrade can create a new replay record. With the same harness version, fixture, saved file, and local database, repeating the replay gives the same attempt and question rows.

## Queued audits

Set `AUDIT_GRANITE_KEYED=enabled` only for an audit Worker environment that already has the queue enabled, Granite configured, and the existing assessment release bindings. Apply migration 0014 to its audit D1 before enabling the route. The keyed policy has a separate cache and checkpoint namespace. The existing non-keyed paths remain available.

The assess delivery reads the verified prepared capture and builds scoped evidence from its primary product region. It sends a single keyed request through the existing Granite guard. The response gets a stable D1 attempt ID bound to the audit and prepared input. Redelivery can finish a received response or reuse a completed checkpoint without submitting another inference. It cannot replace an unresolved attempt with a fresh inference. The hourly cleanup prunes expired response records when the keyed path is enabled.

The public endpoint continues to serve the existing rubric report. The keyed route evaluates 13 selected semantic checks and the scorer retains its deterministic observations and evidence rules for the full rubric. The compact input does not establish exhaustive absence, an unknown size selection, or stock for that selection. Those checks remain unmeasured unless their evidence requirements are satisfied. The apparel attributes require both composition and fit with a dimension, and the current price requires amount and currency from the same scoped observation. The report keeps verified findings and omits a final score while applicable checks remain unresolved. Raw responses stay in D1 and are not served by the report API.
