# Leading wildcard crawl restrictions

The audit crawler supports leading-wildcard Disallow patterns found on merchant sites, including patterns that match a path segment or query suffix. It uses the existing bounded matcher and continues to deny matching paths. Leading-wildcard Allow rules and other unsupported syntax fail closed.

These patterns extend the protocol's documented slash-prefixed path syntax. Their presence does not establish how another crawler interprets the policy. Applicable third-party crawler checks remain unmeasured for these rules.

Kate Spade's public robots file returned HTTP 200 on November 8, 2026 and included leading-wildcard Disallow rules. The previous parser rejected the policy before requesting the product. The correction addresses that observed parser failure. Merchant network responses, product retrieval and report expiry remain separate factors.

[Kate Spade robots policy](https://www.katespade.com/robots.txt) · [Google robots syntax](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec)
