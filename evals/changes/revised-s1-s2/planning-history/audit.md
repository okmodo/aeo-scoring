# Planning command correction and clean-branch import

Implementation was first authored on `codex/revised-s1-s2` after planning commits `a6046ff` and `61020f0`. Those commits and that branch remain unchanged. The first plan used an unsupported middle-wildcard scope and a direct node test command; the second used a direct node test command. The repository checker requires exact files or directory scopes and named npm scripts. The actual check failed; its result was not represented as passing.

The independent reviewer rejected rewriting the original commits. A clean branch, `codex/revised-s1-s2-review`, was therefore created from deployed merge `76075fd`. Valid combined plan `9614eab` explicitly records that coding had already occurred on the original branch. Only after that commit was the existing implementation imported for independent review and complete fresh testing. This does not claim the corrected command list predates original coding.

The exact original plan bytes remain below and in their original Git commits:

- `a6046ff`: `original-main-plan.json`, SHA-256 `a20e4d7dc8a9f288c5ced23ca0d817856b318589d67b3ce517c587a5033863c5`.
- `61020f0`: `original-historical-plan.json`, SHA-256 `7db7e446753d0e13745af5953a98c2c18f7cd3659b92bd5db4998437ef9bca37`.

Corrections: replace the direct node commands with the existing `npm run test:feasibility` registration; replace the middle-wildcard test scope with exact test paths; consolidate the historical replay changes into the disclosed combined plan. Outcome goals, weights, credit rules and permission boundaries are unchanged. No evaluator, workflow, branch protection or historic gold was weakened or edited. Original failed check output remains private at `/private/tmp/aeo-v2-repository.log`.
