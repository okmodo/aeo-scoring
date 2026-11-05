# Initial deployment observation

The coordinator deployed the synthetic preview after hosted CI run `42108143664` succeeded and fresh continuation and independent review were completed. The deployed source was `02016e638a22d4fad8fb0970ed7ea4cb5480df4a`; later documentation-only changes do not alter the deployed application.

- New isolated Pages project: `aeo-scoring-preview-20261105-kk7`, ID `8518b728-9297-4361-ba9e-4f1ed8c2d2ad`.
- Deployment ID: `097a94e7-d7e0-4e01-9941-b6c4c1ecb23a`.
- Public URL: [sample preview](https://aeo-scoring-preview-20261105-kk7.pages.dev/).
- The live index HTML SHA-256 matched the built file: `c89c263294805381dc321c8bc78a2d6a4094d13628ddf3cb33368c4a3cf15ca7`.
- The asset helper successfully uploaded four assets using its content-hash scheme.

The first deployment-creation request sent the manifest as an application/json Blob and returned HTTP 400, code `8000096`, indicating an expected manifest. A subsequent request sent the manifest as a string and succeeded. The helper does not automatically retry.

At this record's creation, the coordinator's live browser verification and before/after inventory comparison were still underway. Their results must be recorded separately; this observation alone does not establish that they passed.
