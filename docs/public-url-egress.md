# Public URL audit Worker

The v1 audit API accepts public HTTP and HTTPS DNS names on standard ports. It rejects IP literals, local and reserved names, credentials and malformed destinations before retrieval. Each redirect is handled manually and its destination is checked before fetching the page. Outbound requests use fixed crawler headers and carry no client cookies or credentials. The existing timeout, byte caps, quotas and assessment statuses apply. Robots.txt is optional evidence for scoring and sitemap discovery. Its rules and availability do not gate product or supporting retrieval. Unsupported policy interpretations remain unmeasured.

The network boundary is Cloudflare global fetch with `global_fetch_strictly_public`. Cloudflare documents that its egress proxy excludes internal services and that the flag routes through public ingress even for the Worker's own zone. The dedicated workers.dev-only configuration adds no custom routes, VPC, private or service bindings. Use that configuration for this transport. The application does not pin DNS addresses. Controlled live probes and deterministic tests cover specific cases, and do not certify every provider-level DNS or address behavior.

Public servers can block crawlers or require JavaScript. Retrieval is HTML-only. A successfully retrieved page can yield an incomplete assessment with no final score because the backend currently measures two structured-data checks.

## Separate deployment

Use the existing backend lockfile and a new Worker named `aeo-audit-public-20261105`. Create a dedicated D1 database, apply [schema.sql](../backend/schema.sql) and set `AEO_PUBLIC_AUDIT_DB_ID` to that new database ID. Generate `AUDIT_RATE_SECRET` in a protected temporary JSON file. This deployment does not use the existing demo database or change the front end.

From the repository root, install backend dependencies with `npm ci --ignore-scripts --no-audit --no-fund --prefix backend`. From `backend/public-deploy`, run:

```sh
../node_modules/.bin/vite build --config ../vite.config.mjs
cf deploy --prebuilt --mode production --dry-run --provision=false
cf deploy --prebuilt --mode production --provision=false --secrets-file /path/to/protected-secret.json
```

Send a POST to `/api/v1/audits` with `{"url":"https://merchant.example.com/product"}` and poll the response's `statusUrl`. Test deployment separately from PR CI.

[Workers security model](https://developers.cloudflare.com/workers/reference/security-model/) · [Public fetch compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public) · [Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html)
