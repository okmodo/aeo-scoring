# Website guide scoring

The public audit can inspect the final site's root llms.txt and both conventional spellings of AGENTS.md. It uses same-origin paths and the existing public-only egress. Robots permissions do not control guide retrieval. It follows neither redirects nor references inside the files. Inspection makes up to three extra requests with an 8 KiB cap per body and a shared 500 ms window within the audit deadline. An unavailable or unverified guide leaves the product audit intact.

S7 identity and S8 context receive credit only when the file identifies the site and provides corroborated storefront context. The supported format has a single Markdown H1 matching the hostname label, a recognized English storefront-purpose statement, and a direct link to the exact audited product URL, whose retrieval has already succeeded. When both agent-guide spellings exist, they must agree for scoring. File contents are untrusted input. The scorer emits a derived observation and the file URL, without reproducing or executing instructions from the file.

The two files are emerging practices. The scorer does not determine whether a crawler reads them. This increment leaves S7 link usefulness and S8 guidance unmeasured because their broader reference quality is outside this inspection. The v1 response shape, rubric weights and incomplete-assessment rules stay in place. New submissions use a new scoring cache namespace.

[llms.txt proposal](https://llmstxt.org/) · [AGENTS.md coding-agent convention](https://agents.md/)
