# PR #1 review remediation dispositions

The initial independent findings are retained unchanged in [security-review.md](security-review.md) and [correctness-review.md](correctness-review.md). Remediation follows the separately committed immutable `ci-review-hardening` plan. No golden fixture or plan was changed.

| Finding | Disposition | Regression evidence |
| --- | --- | --- |
| Upstream base changes falsely appear to predate a plan | Fixed: inspect actual commits in `base..HEAD`, not an endpoint comparison to the immutable plan parent. Combined merge diffs omit inherited upstream changes while checking merge resolutions. | Base updates before and after merge; unplanned merge resolution rejected. |
| Follow-up plan overlapping earlier planned work is rejected | Fixed: authorize each implementation commit with an ancestor plan introduced in this PR. Earlier planned work remains valid when a later plan overlaps its scope. | Both active plans accept refreshed evidence; stale follow-up evidence fails; next independent PR passes without refreshing old records. |
| Implementation plus revert before planning bypasses chronology | Fixed: inspect all feature commits, including files absent from the final diff. A plan must be an ancestor of the implementation commit. | Pre-plan implementation/revert fails both before and after restoration; a side-branch plan merged later fails. |
| Literal `<deleted>` content collides with a missing file | Fixed: serialize typed, length-framed path/state/content records. | A planned deletion passes, but restoring the tombstone bytes rejects the old evidence. |
| Executable mode and symlink retargeting can leave evidence stale | Confirmed and fixed: hash regular-file Git executable mode and symlink target bytes via `lstat`/`readlink`, without dereferencing links. | Mode change and equal-content link retarget reject stale evidence; regular file, missing file and dangling symlink differ. |
| File-to-directory replacements reject a valid removed leaf | Confirmed and fixed during integration review: represent the current directory state explicitly; changed descendants have separate entries. | Both file-to-directory and directory-to-file replacements pass with current evidence and reject subsequent stale evidence. |
| Intermediate immutable plan edit followed by revert | Fixed while checking real history: each plan is introduced only once and every observed plan edit is rejected. | A temporary plan edit restored before evaluation still fails. |

Validation fixtures deliberately use synthetic run/trace records to test validator behavior; these are not task command evidence. Existing frozen scenarios remain unchanged. Real command records, final source-bound fresh-agent evidence, independent patch re-review, and hosted CI are integration work handled by the coordinating agent after source freeze. No push, GitHub message, merge, or deployment was performed by this implementation agent.

The deterministic scope check proves file coverage and ancestry, not whether a broad plan semantically authorizes a changed requirement. Independent review still evaluates task fit, subjective quality, permissions, trace gaps, and supplied evidence authenticity. Normal new-PR compatibility is covered explicitly; plans and evidence already present in the base do not authorize new implementation.
