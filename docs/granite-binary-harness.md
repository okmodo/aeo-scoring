# Granite binary benchmark

The benchmark runs outside the audit Worker. It sends one question per selected rubric subcheck and one Granite request through the configured `default` gateway. The result covers only the selected subchecks and uses their rubric v2 weights.

## Replay the frozen fixture

```sh
npm run test:granite-binary
node scripts/granite-binary-benchmark.mjs offline evals/fixtures/granite-binary-harness.json /tmp/granite-binary-fixture-result.json
```

Use a new output path. The CLI creates the file with owner-only permissions and declines to overwrite an existing result. The synthetic fixture covers grounded passes, unsupported stock status, and a zero supported by a complete shipping-policy inspection.

## Use a prepared capture

Build a private JSON input in the fixture format with one question per selected rubric ID. Use the latest hash-checked prepared capture and include only the parsed sources the operator has associated with the primary product. Each evidence entry supplies an exact source quote, its source ID and scope, and a field-specific kind from the parser or operator's verified classification.

A question can override the rubric's full-credit text with a category-specific pass rule. It lists eligible evidence IDs and up to two required evidence kinds. Use a distinct kind for a person modeling a product, a shipping heading, or a selected configuration's stock status. The harness verifies quotes and scopes and requires all the declared kinds for credit. This check relies on correct source selection and field labels when preparing the input. Reasons are model explanations. Inspect them for semantic errors separately from source and field checks.

A model `fail` earns zero only with eligible evidence of failure or an operator-verified absence backed by complete relevant sources. Set `verifiedAbsenceSourceIds` only after establishing the absence and checking the coverage of the cited sources. An unresolved check has no points and makes the benchmark score incomplete. The benchmark still reports measured findings and their earned points.

For a live calibration, use a private environment with the project account, Workers Paid subscription, and D1 usage ledger. The environment accepts `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_SUBSCRIPTION_ID`, `CLOUDFLARE_BILLING_READ_TOKEN`, `CLOUDFLARE_D1_API_TOKEN`, and `AUDIT_AI_GATEWAY_TOKEN`. An optional `AUDIT_AI_GATEWAY_READ_TOKEN` can read gateway metadata. Use the project's existing billing, D1, and inference permissions. The CLI pins the shared project D1 ledger so it sees the production reservations.

```sh
node --env-file=/private/path/granite-benchmark.env scripts/granite-binary-benchmark.mjs live /private/path/prepared-fixture.json /private/path/new-result.json
```

The live benchmark checks the existing shared usage ledger before sending any inference. It preserves the 60-second model timeout and current request and response bounds. The result records the serialized request size, time from sending the inference request to receiving HTTP headers, time spent in the model call including admission, total benchmark time, and provider-reported neurons when available. A timed-out inference keeps unknown usage. Live calibration writes usage bookkeeping to the existing ledger and saves the model output and verified findings to the private result path.
