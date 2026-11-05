# PR #1 evaluator correctness review

Reviewed local `/Users/keithkarkick/Projects/aeo-scoring` at verified HEAD `1ce219ef0ff014c6bc036127f4d062f572a32c77`, comparing base `4cd8b0f260789c87595ba8c1acfa52942b83119d`. Read AGENTS.md, all evaluator scripts, workflow, process documentation, tests, current plan/handoff and exit record. No source edits or GitHub/network actions.

## Findings

### [P2] Permit a new plan to revise already planned work on the same PR

**Location:** `scripts/pr-gate.mjs:26-28` (especially line 28).

The chronology check treats every earlier change in a new plan's scope as unplanned implementation, even when a previous immutable plan authorized it. Consequently the documented instruction “A changed requirement uses a new plan” cannot be followed for changes to an already implemented file on the same PR. Reproduction: commit plan `first` for feature.txt; commit its implementation; discover a changed requirement; commit plan `remediation` for feature.txt alone; commit the remediation; supply current evidence for both plans. Gate rejects the second plan with `Implementation in this scope predates its plan`. Each plan was independently committed before the work it authorizes, and the first plan was not edited. This blocks ordinary requirement revisions without rewriting existing history or opening another PR. Account for already planned prior work and establish chronology for the new revision rather than demanding the file be pristine since the PR base. Add an integration test covering sequential overlapping plans.

Reproduced in `/private/tmp/aeo-review-remediation-H7jOxe`. The equivalent sequence split into two independent PR bases passes, confirming this is specifically same-PR replanning rather than blanket rejection of future work.

### [P2] Distinguish deletion from real file contents in the source fingerprint

**Location:** `scripts/evaluation.mjs:53`.

The digest substitutes the literal bytes `<deleted>` for an absent path, so deleting a baseline file and restoring it with those exact bytes generates identical fingerprints. Reproduction: baseline contains feature.txt; plan its deletion, commit deletion, and generate accepted source-bound records; restore feature.txt with the nine bytes `<deleted>` without regenerating records; run the gate. Both fingerprints are `ba944826c408f49cb28b0665bd4e282c53eccd71b435d07f971cb36d4e1cb63b` and both gate invocations pass. Evidence for deletion is thus accepted for different source content. Prefix each entry with an explicit file-state/type marker (and preferably unambiguous lengths) before hashing contents, and add a deletion/restoration regression.

Reproduced in `/private/tmp/aeo-review-deletion-UWSzW4`. This is a deterministic collision in the serialized input, not a SHA-256 cryptographic collision. CI's independent rerun of current tests does not make the earlier contributor run/exit record current.

### [P2] Inspect intermediate commits when proving implementation chronology

**Location:** `scripts/pr-gate.mjs:27-28`.

A net tree diff from base to the parent of the planning commit cannot prove implementation did not predate the plan. Reproduction: commit implementation of feature.txt, commit a revert restoring its baseline contents, commit the plan, then reapply the same implementation and create current evidence. Gate reports passed although Git history explicitly shows implementation preceding its plan. The current regression only tests earlier work still visible in the net diff. Inspect scoped changes in individual commits preceding the plan (with appropriate treatment of already authorized plans) rather than only comparing endpoint trees, and add this revert/reapply case. This is an adversarial history-verification gap, separate from subjective evaluation or authenticity of a claimed agent session.

Reproduced in `/private/tmp/aeo-review-chronology-ZAQTRE`.

## Reproduction and verification

All synthetic repositories and fixture evidence are created by `/private/tmp/aeo-review-correctness-repro.mjs`; run `node /private/tmp/aeo-review-correctness-repro.mjs` to recreate four isolated cases. Evidence records in this repro deliberately use synthetic values solely to exercise validator behavior; they are not claimed as genuine task evaluations. The script imports the exact reviewed evaluator and invokes the exact reviewed gate. It creates a baseline `.gitignore` for gate-generated reports to match repository behavior.

Observed output:

- NEXT_PR: exit 0, passed; historical prior plans/evidence do not themselves break a new PR.
- REMEDIATION: exit 1, `Implementation in this scope predates its plan`.
- DELETION_BEFORE and DELETION_AFTER: identical digest above, exit 0, passed.
- REVERTED_EARLY_IMPLEMENTATION: exit 0, passed.

Repository checks passed: `npm run check` (55 files), `npm test` (27 tests), `npm run test:exit` (3 tests). Available runtime is Node v25.9.0, outside declared >=24 <25; these results do not establish Node 24 behavior.

## Boundaries and coverage limitations

The subprocess exit tests accurately label themselves `clean-process-smoke-only`; they read a fixture export and run an absolute entrypoint from the original source tree. This is not a fresh-agent or relocatable-export proof, but the implementation and documentation explicitly acknowledge that boundary, so this is not presented as a separate bug. The genuine fresh-agent result is contributor-supplied evidence; its authenticity requires independent review. I read its recorded observation but did not repeat a fresh-agent exercise or independently authenticate its dispatch/export hash.

The evaluator openly limits its trace to evaluation commands, discloses unknown metrics, requires independent subjective/process review, and reruns mandatory checks in CI. I did not classify those acknowledged human-review boundaries as failures. No application scorer exists, so no product rubric behavior is covered by these infrastructure tests. No hosted CI, protection settings, merge behavior, or deployment was inspected.
