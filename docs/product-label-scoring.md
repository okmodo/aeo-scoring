# Product labels and identity scoring

The raw HTML extractor observes a page title and one explicit main heading. The scoring step compares those labels with the name in a uniquely associated schema.org Product record. Ambiguous or truncated markup stays unmeasured.

The S4 title check awards full credit when both labels match a name that includes the declared model. The C1 identity check awards full credit when the main heading explicitly includes both the declared brand and model. To avoid scoring labels that author styles or scripts may hide, this version excludes documents with stylesheet links, style blocks or executable script elements. Rendered visibility remains unknown. The new checks award points only on positive evidence and leave other cases unmeasured.

The checks use the existing HTML pass, with no new requests or inference. Evidence describes the audited source and is marked as a derived observation. Existing report links keep their recorded results. New submissions use a new scoring cache namespace.

The v1 response and 40/60 rubric weights stay in place. Unmeasured applicable checks continue to withhold the final score.

[Google title guidance](https://developers.google.com/search/docs/appearance/title-link) · [Workers HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/)
