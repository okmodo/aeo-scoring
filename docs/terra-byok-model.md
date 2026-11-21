# Terra through the existing Cloudflare BYOK endpoint

`config/ai-model.json` is the central configuration for the active rubric model: endpoint, model, reasoning, response format, timeout, stage output limits, and request/output byte bounds. The endpoint remains the user-supplied account `/ai/run` endpoint; the model is `openai/gpt-6.1-terra`.

The adapter sends `{model, input}`. `input` preserves the existing messages and JSON-object response mode, maps each stage's existing `max_tokens` to OpenAI `max_completion_tokens`, sets `reasoning_effort: low`, and disables streaming. It omits temperature because sampling controls are incompatible with this reasoning setting. Completion limits include reasoning tokens, so live response completeness still needs validation. Existing prompts, grading, evidence validation, report formats and pipeline stages are unchanged.

The existing Gateway BYOK default provider key supplies the OpenAI credential. The Worker does not need that OpenAI key. Before deployment, the project Worker needs a Cloudflare authentication secret named `AUDIT_AI_GATEWAY_TOKEN`, scoped to this account with Workers AI Read permission. Billing/Analytics/R2-only credentials cannot authenticate inference. This PR does not write or alter any secrets or Gateway settings.

`cf-aig-no-wholesale: true` prevents fallback to Cloudflare Unified Billing when the stored provider credential is unavailable. `cf-aig-max-attempts: 1` requests a single attempt. There are no application retries or provider fallbacks. A single 30,000 ms timer in the rubric caller aborts the HTTP request. Network, provider-envelope, refusal, truncation, invalid JSON and bounded-body errors fail closed without logging provider bodies or credentials.

BYOK inference is billed to the configured OpenAI account, rather than Workers AI neurons. The model caller therefore no longer reserves or settles Workers AI neurons or estimates Llama usage for these calls. Existing infrastructure admission, 60% operating limits, legacy uncertain reservations, 1,000 ms Worker CPU cap, retention, and user-started-only behavior remain unchanged. This change adds no external-provider spending meter. Checkpoint digests include the configured model/settings so incompatible existing outputs cannot silently replay; older audits are not migrated.

Offline tests exercise the actual transport with frozen synthetic HTTP responses, existing rubric fixtures, SQLite/R2 roundtrips, aborts, failures, and checkpoint replay. A fresh agent resumes an exported checkpoint without reissuing the completed HTTP request. These tests do not establish live credential readiness, endpoint compatibility, latency, scoring quality, or provider charges. No live model calls, deployment, Cloudflare configuration changes, frontend changes or dependency changes are part of this PR.

Primary references checked for this change:

- [Cloudflare REST endpoint](https://developers.cloudflare.com/ai-gateway/usage/rest-api/): unified `/ai/run` model/input request and Cloudflare authentication.
- [Cloudflare unified billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/): stored default BYOK selection and no-wholesale header.
- [Cloudflare request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/): maximum attempts.
- [OpenAI Terra model](https://developers.openai.com/api/docs/models/gpt-6.1-terra.md) and [deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist.md): reasoning compatibility.
- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create): JSON-object mode and completion-token limit.
