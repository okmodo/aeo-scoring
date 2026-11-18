# Planning correction

The implementation was originally developed on `codex/open-ai-scoring` after plan commit `2a117d0`. That plan used directory scope entries ending in `/`, which the evaluator does not accept. The original plan is preserved byte for byte in `original-plan.json`; the original branch and its implementation commits remain intact.

This review branch starts at base `a39cdf4ed4acaf61305ce3f039deaab2c003514c`. Its separately committed plan changes only those two scope entries to `backend/**` and `evals/changes/open-ai-scoring/**`. That corrected plan was committed before importing the existing implementation into this branch; it was not committed before the original implementation work. This import does not retroactively change that chronology.
