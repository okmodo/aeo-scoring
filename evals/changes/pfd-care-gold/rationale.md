# Independently adjudicated PFD care correction

Before R7 model outputs, Terra source review found that the frozen PFD input explicitly states “Rinse with fresh water.” The existing category care anchor accepts specific cleaning guidance. The user's existing decision also treats specific applicable care as sufficient. The other three supporting fixture facts—20 oz weight, adjustable fit, and adjustable straps—meet their supporting anchors. Accepting all four therefore yields C2.supporting = 1.0.

The old `not_measured` reference arose because the decoder's care cue omitted `rinse`, despite the frozen expected fact list already including that exact care sentence. R7 candidate recall exposed this implementation/reference inconsistency. Keeping that omission merely to preserve a passing test would suppress true evidence.

Only this PFD reference fraction changes. Weights, anchors, other category outcomes, all 15 assertions per category and shirt78.125 remain. The original reference is retained in Git history at the R6 source revision and the R6 experiment remains closed-failed. This correction is not evidence that any historical model result passed, and does not relax the zero unsupported-proposal release gate.
