# Independent security/process review of PR #1

Reviewed local HEAD `1ce219ef0ff014c6bc036127f4d062f572a32c77` against `4cd8b0f260789c87595ba8c1acfa52942b83119d` in `/Users/keithkarkick/Projects/aeo-scoring`. Read AGENTS.md, workflow, process documentation, evaluator/gate/check scripts and tests. No GitHub contact, source changes, deployment or merge performed.

## [P2] Do not interpret later upstream changes as implementation before the plan

**Location:** `scripts/pr-gate.mjs:26-28` (especially line 27).

The chronology check compares the *current* PR base tree to the plan commit's parent tree. If main advances after a correctly separate planning commit, the comparison includes main's newer changes as deletions from the old parent. Any such file within the plan scope triggers `Implementation in this scope predates its plan`, even after main is cleanly merged into the feature branch and evaluation evidence is refreshed. Broad directory scopes make this ordinary concurrent-development scenario likely. The immutable original plan parent cannot be changed by merging main, so otherwise valid PRs require history rewriting or replacement planning to recover.

**Reproduction:** `node /private/tmp/aeo-security-repro.mjs`, first case. Existing retained fixture `/private/tmp/aeo-security-UDfonE` has history:

```
* fixture records
*   merge updated main
|\
| * unrelated main update after feature plan   [changes common.txt]
* | implementation                           [adds feature.txt]
* | plan before implementation               [scope includes common.txt]
|/
* baseline
```

The unchanged gate exits 1 with `Implementation in this scope predates its plan`; the feature branch never changed common.txt. Inspect implementation commits relative to the branch ancestry/merge base instead of treating endpoint differences against a newer upstream base as feature implementation.

## [P2] Check pre-plan commits, not only their net tree difference

**Location:** `scripts/pr-gate.mjs:27-28`.

The same endpoint diff cannot prove the promised historical ordering: implementation committed before the plan, reverted before planning, then restored after the plan passes unchanged. The history visibly contains the pre-plan implementation, but its net difference at the plan parent is zero. This is a concrete failure of the advertised deterministic plan-history check, independent of contributor evidence authenticity or human judgment. Inspect changes in relevant pre-plan commits, accounting for the actual feature ancestry, rather than only the final net diff.

**Reproduction:** `node /private/tmp/aeo-security-repro.mjs`, second case. Existing retained fixture `/private/tmp/aeo-security-u5Y2P5` has history:

```
* fixture records
* restore pre-existing implementation
* post-hoc plan
* Revert "implementation before plan"
* implementation before plan
* baseline
```

The unchanged gate exits 0 and reports `PR evaluation: passed`.

## Reproduction boundary

The script creates isolated Git repositories under `/private/tmp`, imports the actual evaluation helpers, and invokes the actual unchanged PR gate. It uses structurally valid synthetic run/trace records, like the repository's own gate unit tests; it tests chronology only and makes no claim to have executed the fixture npm commands. Acceptance of contributor-authored evidence is an explicitly documented human-review boundary, not a finding here. Likewise, configured protected-branch rules cannot be established from local files and were not independently verified because external reads were outside this review's authorization. The current workflow uses pull_request, read-only contents permission, credential-free checkout, and pinned actions; no concrete secret exposure was found in that workflow.
