# AEO Scoring

Public product-page AEO readiness assessment. A synthetic sample preview demonstrates the report experience; production assessment is not yet built.

Open **AEO Scoring Vault** as a folder vault in Obsidian, then start with [AEO Scoring Project Specification](AEO%20Scoring%20Vault/AEO%20Scoring%20Project%20Specification.md).

The vault contains atomic linked notes for the 100-point rubric, report experience, assignable priority fixes, recovery calculations, sources, and open decisions. It is independent of BCAG.

Both structure and content scoring are required for the first public release. The agreed frontend is Vite with React and TypeScript; hosting is constrained to Cloudflare free-tier usage.

## Standard PR evaluation

Every PR runs offline evaluation and requires green CI plus independent review before merge. Start with [AGENTS.md](AGENTS.md) and [the evaluation process](evals/PROCESS.md). Use Node 24, run `npm ci --ignore-scripts --no-audit --no-fund`, then `npm run check`, `npm test`, and `npm run test:exit`. Commit task-specific success criteria before implementing; capture current evidence with `npm run evaluate -- --change <id> --base origin/main`. No Cloudflare deployment or paid model calls run in CI.

## Phase 1 foundations

The versioned [rubric](config/rubric.v1.json), [initial category checklists](docs/category-templates.md), and [crawler registry](docs/crawler-policy.md) define scoring inputs. Run `npm run test:foundations` for frozen synthetic arithmetic and configuration checks. These examples are not live audits or human calibration; extraction, model evaluation and Cloudflare resource feasibility come next. See [scoring boundaries](docs/scoring-foundations.md).

## Sample preview

The [live sample preview](https://aeo-scoring-preview-20261105-kk7.pages.dev/) and [hosted preview documentation](docs/hosted-preview.md) show and explain the fictional 84.5-point report, local setup, deployment boundaries, and remaining feasibility gaps. Entered URLs are not fetched or assessed.
