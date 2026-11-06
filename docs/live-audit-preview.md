# Live audit backend preview

The preview runs the v1 API on a dedicated Workers Free Worker and D1 database. Its adapter trusts one operator-approved HTTPS product URL on the public Books to Scrape demo site and that origin's robots.txt. It rejects all other outbound destinations, including redirect hops. It uses standard HTTPS verification and does not implement IP pinning. Keep this adapter confined to known trusted origins. General public audit submissions still require a trusted transport with address pinning and live validation.

The public product page is fetched at audit time. It is a demo catalog page, and a resulting incomplete report reflects only what the current deterministic checks can measure. No browser rendering or AI is used. This API preview does not change the existing front-end deployment or configure cross-origin browser access.

## Deploy a dedicated copy

Check the account, the absence of an existing Worker named `aeo-audit-live-20261105`, and the dedicated D1 target before deploying. Use an existing Workers subdomain or a newly created subdomain if the account has never had one. Leave other projects, domains and existing settings untouched. The Worker config contains no custom domain routes.

1. Create a dedicated D1 database with `cf d1 create --name aeo-audit-live-20261105-db`. Set `AEO_AUDIT_PREVIEW_DB_ID` to its ID. Apply `backend/schema.sql` with `cf d1 query "$AEO_AUDIT_PREVIEW_DB_ID" --sql "$(cat backend/schema.sql)"` from the repository root.
2. In `backend/`, run `npm ci --ignore-scripts --no-audit --no-fund` and `cf deploy --dry-run --provision=false`. This uses the backend lockfile and Cloudflare Vite plugin.
3. Generate a 32-byte random secret in a protected temporary JSON file with key `AUDIT_RATE_SECRET`. Deploy from `backend/` using `cf deploy --provision=false --secrets-file <protected-file>` and remove the temporary file afterward. Keep deployment separate from PR checks.

Submit the exact approved URL through POST /api/v1/audits, then poll the returned statusUrl. A repeat submission after a successful partial report should return the same assessment ID with cache.hit true. Unlisted submissions receive HTTP 400 before storage or retrieval. Retrieval failures for an approved submission end as unable_to_assess without a score. A terminal response with robots_unavailable indicates that the target's robots policy could not be verified. Check deployed status and headers from a public client, because packaging checks do not run D1, HTMLRewriter or the Cloudflare network.

[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [D1 Free quotas](https://developers.cloudflare.com/d1/platform/pricing/)
