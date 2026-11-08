# Audit service backend

The proposed wire contract, TypeScript definitions and frozen response bodies live in [contracts/v1](../contracts/v1/README.md). This branch uses the Phase 2 PR as its base so the backend and its evaluation contain only this work. After the base PR lands, retarget the backend PR to main and verify its checks on the new base.

The Worker entry point is backend/service.mjs. It accepts a URL, atomically admits or reuses an audit, and returns a polling link. It uses a D1 lease and background execution for bounded retrieval. Polling converts an abandoned lease to a terminal timeout. A successful retrieval can produce a partial assessment and a cached partial result. Product JSON-LD entity and core-property observations are supported. A final score requires all applicable checks and a supported product category. The complete response example exercises the contract with synthetic data.

The deployment integration needs these pieces:

| Item | Integration requirement |
| --- | --- |
| AUDIT_DB | A D1 database initialized with backend/schema.sql. |
| AUDIT_RATE_SECRET | A backend secret of at least 32 characters. Rotate with awareness that the current client window will receive new keys. |
| AUDIT_EGRESS | Trusted transport for HTTP and HTTPS. The transport must resolve and validate public addresses, pin the connection to an approved IP, verify TLS for the requested host and prohibit internal destinations, forwarding credentials and automatic redirects. The Worker validates each redirect destination. Robots policy is optional evidence and discovery input. |
| HTMLRewriter | Cloudflare runtime parser. Offline tests inject a stand-in and verify the service lifecycle independently of Cloudflare. |
| Ingress and cleanup | Cloudflare-provided client IP header and a scheduled cleanup invocation, preferably hourly. Configure the public API route in coordination with the frontend adapter. |

The egress transport is an explicit integration dependency. The Worker returns service_unavailable when the binding is missing. Application URL checks alone cannot defend against DNS rebinding. The transport has to enforce public IP pinning for each actual connection, including robots requests. The free-tier runtime and egress path require an isolated benchmark before public use.

The document is buffered within a 512 KiB retrieval limit and inspected with the runtime parser. Robots input is capped at 64 KiB and all retrieval shares an eight-second timeout. Unsupported robots policies leave crawler scoring unmeasured and do not prevent retrieval. The parser scans supported HTML fields without building a JavaScript DOM. It cannot establish rendered visibility, and its retained structured data and markup coverage are limited. Source markup, crawler declarations and retrieved text are untrusted.

The client quota key is an hourly HMAC digest of the platform address. Storage contains the submitted and final URLs, bounded evidence and report data, and admission digests. The scheduled handler prunes expired reports and old quota records in bounded batches. Configure backup and retention behavior separately before deployment. Browser responses carry no-store and noindex directives. Report links can be opened by anyone who has the opaque ID.

The backend owns contracts/v1, backend source and database schema. The frontend owns the presentation and mock adapter. Shared dependencies, frontend route wiring and deployment configuration require coordination. Use the frozen examples to build the UI independently. The proposed defaults are documented with the response contract.
