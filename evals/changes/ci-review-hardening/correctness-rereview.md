# PR #1 independent correctness re-review

**Reviewed final implementation head:** `1e893b5646c61c8257f5a43e6533bc603dc1da4f` in `/private/tmp/aeo-pr1-review-fixes`. Verified exact HEAD and clean working tree before and after final checks. Original reviewed head: `1ce219ef0ff014c6bc036127f4d062f572a32c77`.

**Result: no remaining actionable correctness findings in the reviewed changes or tested cases.** All original findings and the two additional stale-evidence bypasses found during re-review are fixed. This is a bounded code-review result, not a claim that arbitrary contributor-supplied records or an unobserved agent session have been authenticated.

## Independent reproduction results

Ran `/private/tmp/aeo-review-correctness-rerepro.mjs` against the final implementation. The script imports the corrected evaluator, invokes its gate in isolated temporary Git repositories, and uses explicitly synthetic validator evidence.

| Scenario | Observed final behavior |
| --- | --- |
| Normal next PR retaining old plans and evidence | Passes; previous PR evidence does not require refresh |
| Same-PR changed requirement with separately committed overlapping follow-up plan | Passes with refreshed evidence for both active plans |
| Deleted file restored with literal `<deleted>` contents | Digest changes; stale evidence rejected |
| Implementation committed and reverted before the plan | Rejected as implementation predating its plan |
| Rename subsequently changed to a copy by committing restoration of the original | Original deleted path is represented; digest changes; stale evidence rejected |
| First sorted filename contains leading whitespace and its contents change | Actual pathname is preserved; digest changes; stale evidence rejected |

Final isolated fixture paths: next PR `/private/tmp/aeo-review-next-pr-btG7cx`; remediation `/private/tmp/aeo-review-remediation-XMBcNc`; tombstone `/private/tmp/aeo-review-deletion-QLXe24`; chronology `/private/tmp/aeo-review-chronology-LZWCZL`; rename `/private/tmp/aeo-review-rename-copy-PTtUpo`; whitespace `/private/tmp/aeo-review-whitespace-9sWJ0V`.

## Inspected fixes and regression quality

Read the immutable `ci-review-hardening` plan, original-to-final evaluator/gate diff, and all added regressions. The history walker now inspects actual PR commits with ancestor-specific available plans, rejects reverted or retroactive implementation, permits sequential overlapping plans, and avoids treating upstream-only work as branch implementation. Regression tests cover changed base branches, upstream merges, plans introduced on another branch, merge-resolution work, edits to plans later reverted, next-PR lifecycle, and stale follow-up evidence.

The typed, length-framed fingerprint distinguishes deletion from real content, regular files from symlinks, symlink targets even when dereferenced contents match, dangling links, executable mode, and file/directory replacement. Directory-to-file transitions handle ENOTDIR for formerly tracked descendants. The added reshape test proves initial evaluation can pass in both directions and subsequent content changes invalidate evidence. NUL-delimited Git filename lists now use raw output, and rename detection is disabled when enumerating fingerprint paths. Regressions verify leading spaces, tabs, trailing spaces, tracked paths and untracked paths.

The two additional defects reported at intermediate b98e50c were therefore resolved at final HEAD: rename source omission and unconditional trimming of NUL-delimited Git paths. No further stale-evidence bypass was found in the tested cases.

## Observed final checks

Executed against the stable final head:

- `npm test`: **43 passed, 0 failed/skipped**.
- `npm run test:exit`: **3 passed, 0 failed/skipped**.
- `npm run check`: **passed**, checking 60 files, syntax, JSON, vault links, rubric weights and workflow policy.
- Independent six-scenario reproduction described above: all results matched intended acceptance/rejection.

An earlier mixed-version suite run while implementation was being edited was discarded as non-final; the stable final run above replaces it.

## Limits

Available runtime is Node 25.9.0, outside declared >=24 <25. These checks do not establish Node 24 or hosted CI behavior. I did not independently authenticate a fresh-agent dispatch, exported Git bundle hash, remote branch protection, merge behavior or deployment. The subprocess exit tests accurately describe their smoke-test boundary; fresh-agent continuation and subjective process claims still require the independent review documented by this repository.

The fingerprint covers the Git-relative changed set and deliberately excludes derived run/trace/exit records; this review does not expand it into whole-environment or whole-agent-session attestation. No application scorer exists, so product rubric behavior remains outside this infrastructure suite. All review actions were read-only with respect to source; only temporary reproduction repositories and this report were written. No GitHub contact, merge, deployment, or paid model call was performed.
