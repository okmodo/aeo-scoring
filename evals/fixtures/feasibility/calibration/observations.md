# Bounded real-product observations

These are independent agent assessments against `config/categories.v1.json` version 1.0.0, prepared before comparing extractor output. They are **not human ground truth**, full audits, complete HTML snapshots, or total scores. The observations below concern only the cited bounded indexed page text as returned by web search/open on 2026-11-05; the service reported cached crawls, so this is not necessarily the page's state at observation time. Live pages and variants can change. Evidence is quoted sparingly; locations are headings and product-detail sections rather than stable selectors.

The web service's readable text does not establish whether content was present in an initial raw HTTP response, required JavaScript, or was available to a specific crawler. Raw and rendered availability, response status, robots eligibility, redirects, and complete-page absence were not independently measured. Do not use these examples as extractor inputs or count agreement unless the extractor is evaluated on the same observed evidence and its output is actually recorded. Unobserved details are **not measured**, not absent. The synthetic offline fixtures exercise missing, contradictory, and render-required conditions separately.

## Running shoes: Brooks Ghost 18

Source: https://www.brooksrunning.com/en_us/mens/shoes/road-running-shoes/ghost-18/1104931D362.115.html

Context: US men's product page, color 362 and URL size 11.5; selected width is not established by the bounded text. Indexed product-details section, “Best for,” “Midsole drop,” and “Weight.”

| Category attribute | Bounded evidence | Expected assessment | Rationale |
| --- | --- | --- | --- |
| surface | “Road running” | full | A specific intended running surface is stated. |
| drop | “10mm” under midsole drop | full | The drop has a length unit. |
| weight | “10.2oz / 289.2g” under weight | partial for excerpt | Weight and units are given; reference size and per-shoe/pair scope are not established in this excerpt. This is not a full-page absence finding. |
| width | Width options are listed in indexed text. | not measured | Available options do not establish which width is selected for this variant. |

## Casual daypack: Patagonia Atom Daypack 24L

Source: https://www.patagonia.com/product/atom-daypack-24-liters/48230.html?cgid=luggage-backpacks

Context: product page, indexed text shows Berry Fig and style 48230; evidence from title and “Specs & Features.”

| Category attribute | Bounded evidence | Expected assessment | Rationale |
| --- | --- | --- | --- |
| capacity | “Atom Daypack 24L” | full | The named pack's capacity has a volume unit. |
| laptop-size | “fits laptops up to 13” followed by inch mark | partial for excerpt | The limit and unit are specified but the measurement convention is not established in the excerpt. The laptop sleeve makes this conditional attribute applicable. This does not prove the convention is absent elsewhere. |
| dimensions | Not assessed in the bounded evidence. | not measured | No claim is made about the full page. |

## Basic T-shirt: Hanes EcoSmart #5170

Source: https://www.hanes.com/products/hanes-ecosmart-reg-crewneck-men-s-t-shirt/5170

Context: indexed product page shows Oxford Grey; no selected size is established by the bounded text. Product Details section.

| Category attribute | Bounded evidence | Expected assessment | Rationale |
| --- | --- | --- | --- |
| care | “machine washing this unisex tee in cold water” | partial for excerpt | Specific washing guidance is present, but drying or other care is not established in this excerpt. This does not establish its absence from the full page. |
| size | Size options are shown. | not measured | An offered size is not necessarily the selected size. |

## Calibration limitations

These illustrative checks have not been compared with an extractor run or independently scored by a human. A genuine calibration study needs frozen, lawfully retained inputs, independently assigned human judgments and adjudication, a defined matched evaluation scope, measured agreement including disagreements, and documented sampling limits. Three selected products cannot establish general accuracy. No agreement percentage or human calibration is claimed here.

## Raw access attempt

At approximately 2026-11-05 20:00 UTC, a single request per host for `/robots.txt` was made using `curl --max-time 15 --location --max-filesize 500000` and user agent `AEOResearchBot/1.0`. Initial requests from the restricted environment failed DNS resolution; an authorized network-enabled attempt produced the results below. Times are curl's total request times, not page-rendering measurements. No product-page requests followed because the robots policy could not be established. No challenge was bypassed. Response bodies were retained only temporarily under `/private/tmp` and are not committed.

| Host | Result | Bytes | Time | SHA-256 of response body |
| --- | --- | ---: | ---: | --- |
| www.brooksrunning.com | HTTP 403; HTML response | 389 | 0.292 s | `95bdb527c2578435f7f4f089085e742ed0a13a5558acf87ad61fc9c4e896802c` |
| www.hanes.com | HTTP 403; HTML response | 769 | 0.165 s | `e2c46de565e1d37e9342eca47760106ef0d9a9415289fe60c2dd6d96788f0b66` |
| www.patagonia.com | HTTP 200, but HTML maintenance response instead of robots rules | 3300 | 0.309 s | `29fa8dcff45d5cf0e303a8f9999d407abacde5047074fb0754f36c94c43b83dd` |

These access failures are not product extraction results and do not establish what the live product pages would return. The examples above remain indexed-text observations only.
