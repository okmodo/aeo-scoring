# Planning correction

The initial plan was committed in a3795c3 before application implementation on the local branch `codex/shared-report-v2`. It incorrectly listed two direct Node test commands; this repository only permits named npm scripts in plans. The initial `npm run check` failed on that grammar.

Implementation had already been developed under that invalid plan. The original plan is preserved byte-for-byte in `evals/changes/shared-report-v2/original-plan.json`. An initial attempt to archive and replace the plan on the same branch passed command evaluation but failed the history gate: a historical plan cannot be deleted, and plan commits must contain only plans. No checker was changed to accommodate this.

The earlier local branch is retained at 4bee82cc9c10e7a68117d2f3aebd86d95fef5bab. The final proposed branch, `codex/shared-report-v2-contract`, starts from main. Its first commit d5c5260 contains only the valid corrected plan with named scripts. The saved implementation patch was replayed after that commit; this disclosure and the original plan artifact entered with implementation.

This is a disclosed process limitation: the corrected plan did not precede the first development of the saved patch. It does precede implementation on the proposed branch. No evaluator, history check, test expectation or permission requirement was weakened. Independent review must assess this chronology alongside the code and recorded evaluation.
