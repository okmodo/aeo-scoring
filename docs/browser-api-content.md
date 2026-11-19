# Native Browser content capture

The product-page capture path makes one request through the existing Cloudflare Browser binding:

```js
const response = await env.AUDIT_BROWSER.quickAction('content', {
  url: publicProductUrl,
});
```

The request uses provider defaults without `gotoOptions`, `waitForSelector`, `waitForTimeout` or `actionTimeout` overrides. In the guarded Faherty comparison, the custom settings returned HTTP 422 / 6002; the default request returned HTTP 200 and rendered product HTML. This comparison does not isolate which custom setting caused the timeout. The existing 28-second application deadline still applies, including when provider defaults would wait longer.

Cloudflare handles navigation and page resources. The application does not intercept requests, set a custom browser identity, create Playwright sessions, proxy resources through the Worker, or fetch an HTTP fallback in this path. The native binding needs no additional API token. Historical session cleanup remains for previously recorded sessions.

The native response is a JSON envelope with `success`, rendered HTML in `result`, and `meta.finalUrl` / `meta.status`. The complete HTML result, up to 8 MiB of UTF-8, is stored in the existing private R2 bucket before HTML extraction or model work. The JSON transport envelope is independently limited to 16 MiB to bound Worker memory; unusually escaped JSON can hit that limit even when its decoded HTML would fit in 8 MiB. Responses outside either bound fail explicitly before persistence; HTML is never silently truncated. Public navigation targets and returned final URLs must pass the existing public-target validator. Non-success origin responses are retained as evidence but cannot be graded as product pages.

A later assessment invocation reads and verifies the R2 bytes, derives HTML observations, and saves immutable `inputs` alongside the retained snapshot. Assessment resumes from these inputs. No further browser request is needed. Objects retain the existing 24-hour expiry, hash verification and private access. The existing assessment-source budget is 4 MiB; retaining a larger capture does not imply that it can all be supplied to the model. Source-budget exhaustion remains explicit.

The content API supplies **rendered HTML**, not the initial HTTP response or proof of computed visibility. It must not satisfy a source-only S1/S2 subcheck. Such applicable checks remain unmeasured when the required source evidence is unavailable; an incomplete assessment has no final numerical score. Other scoring rules and weights are unchanged.

## Usage accounting

Quick Actions bill browser hours; they do not consume Browser Sessions concurrency. Admission uses the same account-wide 60% operating limit (21,600,000 browser milliseconds), current available account analytics, and a conservative 62-minute reservation. Only one unresolved capture is admitted at a time. Legacy unresolved session reservations also block admission, and a database interlock prevents old and new capture paths from racing.

Only the provider response's outer `X-Browser-Ms-Used` header settles that reservation. Origin headers inside `meta` cannot settle it. Missing, malformed or unavailable usage evidence leaves the hold intact. A valid zero is provider evidence, not a fallback. Settled actuals form a local floor against delayed analytics; actuals and already accounted reservations are not blindly added together. The accepted analytics sampling/reporting limitation remains. This is not a provider invoice hard cap.

The client waits at most 28 seconds. A late response may reconcile known usage but cannot trigger a late R2 write or extraction. This timeout cannot forcibly terminate provider work; uncertain usage remains reserved. The Worker CPU cap remains 1,000 ms, and all other service guards remain enabled.

## Deployment

Apply project migrations `0008-browser-content-inputs.sql` and `0009-quick-action-allowances.sql` before activating the new bundle. Preserve existing bindings, secrets, monitoring, hourly legacy-cleanup cron, release flags, 60% limits and CPU cap. No frontend or unrelated Cloudflare service changes are needed. Offline tests do not establish merchant-site parity or live runtime CPU consumption.

Primary references: [content endpoint](https://developers.cloudflare.com/browser-run/quick-actions/content-endpoint/), [Quick Actions binding](https://developers.cloudflare.com/browser-run/quick-actions/), [Browser pricing](https://developers.cloudflare.com/browser-run/pricing/).
