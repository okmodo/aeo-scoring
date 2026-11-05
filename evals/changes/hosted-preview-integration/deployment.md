# Initial deployment observation

The coordinator deployed the synthetic preview after hosted CI run `42108143664` succeeded and fresh continuation and independent review were completed. The deployed source was `02016e638a22d4fad8fb0970ed7ea4cb5480df4a`; later documentation-only changes do not alter the deployed application.

- New isolated Pages project: `aeo-scoring-preview-20261105-kk7`, ID `8518b728-9297-4361-ba9e-4f1ed8c2d2ad`.
- Deployment ID: `097a94e7-d7e0-4e01-9941-b6c4c1ecb23a`.
- Public URL: [sample preview](https://aeo-scoring-preview-20261105-kk7.pages.dev/).
- The live index HTML SHA-256 matched the built file: `c89c263294805381dc321c8bc78a2d6a4094d13628ddf3cb33368c4a3cf15ca7`.
- The asset helper successfully uploaded four assets using its content-hash scheme.

The first deployment-creation request sent the manifest as an application/json Blob and returned HTTP 400, code `8000096`, indicating an expected manifest. A subsequent request sent the manifest as a string and succeeded. The helper does not automatically retry.

## Post-deployment verification

The coordinator verified all four public assets returned HTTP 200 and exactly matched the reviewed local build bytes. Asset SHA-256 values:

- `index.html`: `c89c263294805381dc321c8bc78a2d6a4094d13628ddf3cb33368c4a3cf15ca7`
- `favicon.svg`: `6946ab14f5071af7921d6cd7e457a488df448d0269573218a83605fc2e1e4882`
- `assets/index-CcweCGvB.css`: `d8eeb3c5bc01fdcd33652cef049afc1919cc54b0b41aad5d9c4f523507d89b39`
- `assets/index-Du06zAxf.js`: `2c383286d2d2b5707cbe2cca93f5aeac8a2e60f17d4efc8afc3d91070e466748`

A dedicated browser visited the public URL and completed the sample flow: three initial actions, five after expansion, 40 displayed subchecks, no request to the entered example.com URL, and no echo of that entered URL in the report. At a 390px viewport the document width was also 390px. The public-page console reported zero errors and zero warnings. Earlier local checks exercised progress cancellation, focus and the 1440px desktop layout; this is limited functional review, not an accessibility certification.

Read-only inventories immediately before project creation and after deployment showed zero Worker scripts, zero Worker custom domains, zero zone Worker routes, one unchanged zone count and an absent account Workers subdomain in both. Pages projects changed from zero to exactly this new project's matching ID. Cloudflare writes were limited to creating this new project, its token-scoped static asset uploads and its deployment. No existing service, account setting, DNS, route, domain or billing endpoint was modified. This is a scoped inventory and action record, not an exhaustive audit of every Cloudflare setting.

Subsequent documentation and evidence changes require current evaluation and hosted CI. No app code changed after the reviewed deployment.
