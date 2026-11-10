# Free-tier HTML extraction performance investigation

The complete audit has not been shown to fit the Cloudflare Free CPU budget. A temporary Cloudflare probe previously reported 418 ms CPU on the captured product case; successful requests do not establish that the audit meets the Free limit. The probe was removed, and these measurements do not change deployed services. Synthetic cases also exceeded the target in that probe. See `content-facts-runtime.md` and the evaluation record for the probe's scope and limitations.

## Local isolation

On the same captured 364 KiB product page, a local Miniflare experiment measured elapsed time around a request, HTML transformation, and response. Each range below is ten warm samples. These numbers are **not Cloudflare CPU measurements** and include local runtime, transport, and timing noise. They isolate where to investigate; they cannot prove eligibility for Free.

| Local operation | Elapsed range | Callback counts |
| --- | ---: | --- |
| Request and response baseline | 1.9–4.5 ms | None |
| Bare HTMLRewriter transform, no handlers | 2.3–2.8 ms | None |
| No-op wildcard element handler | 10.6–14.3 ms | 1,257 elements |
| No-op document text handler | 32.6–37.7 ms | 4,694 text chunks |
| Both no-op handlers | 37.0–42.6 ms | 1,257 elements, 4,694 text chunks |
| Approximate legacy selector set with no-op element and text handlers | 23.0–26.5 ms | 331 elements, 3,102 text chunks |

The native parser with no handlers was close to the request baseline; crossing into JavaScript callbacks accounted for a substantial part of the local cost. The approximate selector experiment is not the production implementation and does not establish equivalent extraction. Earlier local stage isolation observed full product extraction at about 57–78 ms elapsed; removing the product accumulator entirely lowered that to about 23–38 ms, but removed product evidence and is not an acceptable optimization. A trial that removed non-JSON-LD script and style elements produced no measurable local improvement on this case. A trial that replaced ancestor scans with inherited state and tracked active text collectors produced identical DTOs for sampled fixtures but no measurable local improvement; it was reverted.

## Design implications

Reducing JavaScript callback count is a better lead than changing scoring arithmetic. A possible redesign would use more selective native handlers for relevant product, identity, control, link, and structured-data evidence, while preserving nested text assembly, hidden and related-content handling, microdata scope, JSON-LD completeness, malformed input behavior, element locations, and all bounded-work rules. Before adopting it, compare the **entire** extraction and resulting report against frozen happy, ambiguous, malformed, truncated, policy, and large-input fixtures. An unsupported or incomplete input must remain explicitly incomplete rather than yield a confident absence. Fewer callbacks and local elapsed time alone are insufficient: measure the actual bundle's Cloudflare CPU on synthetic and real cases without weakening evidence.

If a single invocation still exceeds the budget, investigate a bounded, resumable design with independently scheduled stages and durable, access-controlled state. Verify the actual platform CPU accounting, free-tier quotas, request limits, storage, retention, retries, and continuation mechanism before selecting an architecture. Splitting only scoring from extraction does not solve extraction exceeding the limit. Splitting an HTML stream at arbitrary byte boundaries does not preserve parser state, nested scopes, or complete evidence; any extraction continuation must retain the required parsing context or use independently valid bounded units. Each stage needs deterministic input identity, idempotent retries, explicit failure and truncation states, and a final reconciliation that cannot convert missing work into absence. An asynchronous function within one invocation must not be assumed to reset its CPU budget. No staged design has been implemented or proven feasible under the Free limits.
