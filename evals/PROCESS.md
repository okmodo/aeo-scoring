# Standard evaluation for every PR

Open or update a PR to run `.github/workflows/pr-evaluation.yml`. No path exemptions apply, including docs-only changes. CI executes the three mandatory commands and every additional task-plan command once, captures their actual outputs/durations, and validates task-specific, source-bound evaluation evidence. Protected main requires the named `PR evaluation` check and independent approval. CI never automatically merges or deploys.

## Before implementation

Copy `evals/templates/plan.json` to `evals/changes/<id>/plan.json`. Define outcomes, process, style/efficiency, scope, non-goals, verification commands, and exit-test applicability. Commit plans alone before implementing. Plans are immutable after introduction; new requirements use another plan. For a new independent PR use a new plan; old run evidence cannot satisfy it. The gate inspects every commit reachable from the feature head but not the current base. Each implementation commit must have an ancestor plan from this PR whose scope covers its files; an overlapping follow-up plan does not invalidate earlier planned work. Reverting unplanned work does not erase its history. Plans on another branch authorize work only after they are ancestors of that work. Pure upstream merge content is excluded; changes introduced by a merge resolution still need prior planning. Intermediate plan edits are rejected even if later reverted.

## Evidence produced by real commands

Run `npm run evaluate -- --change <id> --base origin/main`. It executes named npm scripts without arbitrary shell expressions, records output hashes, command sequence, elapsed durations, return codes, source commit and content digest, plus `trace.jsonl`. Full command outputs remain under ignored `reports/` and hosted CI retains its own logs and artifact for seven days. The committed record explicitly says its trace covers evaluation commands only. Include a concise redacted development summary when the host cannot export a tool trace.

Do not claim the wrapper observed prior planning conversations, permissions, all tool calls, token use, costs, or subjective judgment. Null token/cost data means unavailable, never free or zero. Offline CI performs no paid API calls. Future agent-host trace imports must preserve provenance and redact sensitive material before publication. Record external side effects rather than assume a test's exit code proves none occurred.

CI fingerprints changed source, plans, and handoffs relative to the PR base, including explicit missing/file/symlink state, file executable mode, and symlink target bytes. It hashes symlink identities without reading their targets. Only run/trace/exit-result files are excluded to avoid self-referential hashes. A source change, base update affecting the changed set, or handoff change needs current evidence. Results are assertions supplied by a contributor; CI re-executes its own required commands and human review checks evidence authenticity. A changed CI script can weaken CI, so workflow/evaluator/fixture modifications require particular independent review.

## Five frozen scenarios

`evals/fixtures/scenarios.json` versions explicit outcomes and side effects for a permitted offline check, a missing-evidence edge, an unauthorized side effect, invented evidence, and an interrupted-task export. `test/evaluation.test.mjs` exercises these plus stale evidence, malformed contracts, scope escapes, and incomplete handoffs. These test evaluation infrastructure, not the as-yet-unbuilt AEO scorer. Later product work must add frozen HTML/extract/model-output fixtures and rubric expectations before implementing each behavior.

## Exit test

Every PR includes `handoff.json` with task, decisions, constraints, completed/remaining work, exact state, and replay commands. `npm run test:exit` proves a separate process can read the export and that missing state is rejected; it does not prove an agent can resume.

When a PR changes portability, memory, workflow, handoff, or resumability, mark exitTest.required true and perform the real exercise: stop at a meaningful incomplete boundary; make a clean export without private chat, including a Git bundle with the base/plan/source history and an export-state.json identifying the branch and refs; give only that export and clean task files to a fresh agent/session; clone the bundle in a clean directory so planning chronology and source-bound evaluation can be replayed without the original checkout; observe continuation against the task goals; record `exit-result.json` including agent identifier, export hash, source digest, interruption point, observed result, and limitations. A human checks authenticity. CI requires the fresh-agent record for applicable changes, not an automatic paid model call. Unrelated PRs give a specific non-applicability reason, reviewed independently.

## Human review before merge

Reviewer verifies outcome evidence, correct tools and sources, task/permission boundaries, reasonable approach, conventions, command repetition and scope, authentic metrics/unknowns, and any subjective or exit-test result. Never replace review with a checkbox checked by the author. No LLM judge is needed for the initial infrastructure; later subjective model calibration is a separate budgeted workflow.

When application code appears, register lint/typecheck/build and meaningful runtime/rubric tests in CI. No placeholder build or typecheck passes exist now. All current tests are offline. Free GitHub-hosted public-repository checks are separate from Cloudflare deployment, which remains out of scope.

## Sources

- [OpenAI: Testing agent skills with evals](https://developers.openai.com/blog/eval-skills): outcome/process/style/efficiency and trace-backed evaluations.
- [GitHub workflow security](https://docs.github.com/en/actions/reference/security/secure-use): least privilege, pinned actions, untrusted PR handling.
- [GitHub merge rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets): required PRs, status checks, review.
- [Exit-test reference supplied by user](https://www.infoworld.com/article/4243401/before-you-buy-an-ai-agent-make-it-pass-an-exit-test.html): independent continuation from exported state.

The supplied YouTube pages could not be retrieved; their contents are not claimed as inspected. The user's stated requirements remain the process authority.
