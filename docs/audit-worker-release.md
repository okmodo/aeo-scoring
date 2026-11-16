# Audit Worker releases

The public audit service is released manually after independent review and required CI, as required by AGENTS.md. The frontend is built from the repository root and published to the existing Cloudflare Pages preview.

The audit Worker must not have Git build triggers that run the frontend build and deploy its output. A root-directory build followed by `wrangler deploy` can replace the audit service with a frontend Worker and drop its runtime bindings. A corresponding `wrangler preview` trigger also uses the wrong entry point.

## Build configuration correction

The intended configuration has no root/frontend Git build triggers attached to the production audit Worker or its frontend branch preview. The shared repository connection stays available to other resources. Frontend pushes and merges can run the required GitHub checks without triggering these Worker deployments.

Release the audit service only from the independently reviewed backend commit and its `backend/public-worker.mjs` entry point. The current deployed backend can be ahead of main while its integration PR is open. Building the older backend on main can also regress the service.

For each authorized backend release, compare the intended configuration with the active version before uploading. Preserve the D1 binding, password secret and gated-access setting, AI/release settings, usage-read and rate-limit secrets, billing scope, analytics admission, 60% included-allowance ceilings, and 1,000 ms CPU cap. Keep secret values out of source, build assets, logs and committed evidence.

After release, verify the active version at 100% traffic and inspect that version's resources. The script settings endpoint can describe the newest uploaded version even after traffic is rolled back to an earlier version. Verify password unlock, rejection of unauthenticated submissions and report reads, and the intended product report behavior within ordinary usage admission.

No Worker upload or audit/model run is needed to correct build triggers. Keep the active service version and Pages deployment pinned during this configuration change.
