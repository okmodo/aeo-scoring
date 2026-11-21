# Shared prepared data and a single model timeout

The active prepared assessment uses one application-level model response timeout: 30,000 ms per request. It does not shorten that wait with a separate 25-second or 35-second processing deadline. The account-wide 60% allowance checks, request/output limits, one new model call per checkpoint invocation, 128-step bound and 1,000 ms CPU cap remain in force.

The prepared job lease controls ownership and permission to save a result. It is not a timer that cancels the model. A timeout leaves the model checkpoint uncertain and its conservative usage hold in place; no automatic second inference is authorized.

The ownership lease is 45 seconds. It may still expire on unusually slow storage I/O, in which case the existing fencing checks reject stale writes. It does not impose a shorter AI response wait.

## Why deterministic results were missing

Previously, `readPrepared()` supplied the verified cleaned HTML and an intentionally empty extraction record. The scorer's deterministic routines need extracted fields, not only a raw HTML property. The consumer also required AI assessment and suppressed most positive findings without validated model output. A model timeout therefore published a report with no measured checks even when the prepared page contained usable technical evidence.

Deterministic checks must derive eligible observations from the same verified prepared R2 page used by AI. They must not download the page again or read the original `/html` object. The canonical AI input and its checkpoint binding remain stable. Supported deterministic findings must survive model failure and must not be erased by an unmeasured AI proposal.

The consumer derives observations once when publishing a finished or failed assessment, rather than repeating parsing on every checkpoint yield. The helper verifies the prepared artifact and cleaned HTML hashes, binds its result to the originating snapshot, and rejects later mutation. The scorer validates AI output against the untouched canonical input before using the derived view for deterministic observations. Independently established robots and sitemap findings survive report assembly.

This changes input wiring, not the rubric. Structure remains /40 and Content /60. Checks requiring original-response provenance or computed visibility remain unmeasured when those observations were never captured. Model-dependent content judgments remain unknown without validated AI output. Missing applicable checks still produce **Assessment incomplete** with no final total; retrieval failure still produces **Unable to assess** with no number.

## Runtime ownership

The private RPC assessment method keeps its result promise active and registers that work with `waitUntil()`. This allows checkpoint persistence to continue when its caller ends. The existing preparation notification remains asynchronous and the eight-hop continuation bound remains unchanged. No public execution route, new service or paid product is added.

Cloudflare documents a 30-second post-response extension and cancellation when an RPC caller's execution context ends. Those platform rules are separate from the application model timeout. References: [Worker limits](https://developers.cloudflare.com/workers/platform/limits/), [RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/).

## Verification boundaries

Offline fake timers establish the 30-second response timeout and the absence of application deadline clipping. Native local workerd checks exercise the production RPC methods, awaiting completion and continuing after an HTTP response. The long synthetic local test also passes under the earlier RPC behavior; it does not prove production enforcement of the platform's post-response cutoff.

Frozen SQLite/R2-compatible fixtures must establish retained deterministic evidence on model failure, stable AI checkpoint replay, and no original HTML reads. These checks do not measure production CPU, provider latency or billing freshness. Production activation requires reviewed source, passing hosted CI and deployment authorization. Frontend files, dependencies and unrelated Cloudflare services are outside scope.

Native local parsing and scoring used actual HTMLRewriter: a synthetic 435,704-byte page took 448 ms local wall time; a 4,128,768-byte page took 1,991 ms. The latter is a material runtime risk near the existing prepared-input maximum. These measurements include fixture/hash work and do not prove production CPU fits the 1,000 ms cap. No cap increase or live model invocation is part of this change. New submissions use `prepared-assessment-v3`; older audits remain unchanged.
