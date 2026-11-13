# Full-source pre-output adjudication

The canonical [scoring contract](../../../AEO%20Scoring%20Vault/01%20Specification/AEO%20Scoring%20Contract.md) requires confirmed absence for zero and reserves `not_applicable` for explicit rules. [C3](../../../AEO%20Scoring%20Vault/01%20Specification/AEO%20C3%20Purchase%20Information.md) allows an accessible directly linked policy to supply terms, so a complete product region with unknown policy coverage is not by itself proof that terms are unavailable. [C4 category coverage](../../../AEO%20Scoring%20Vault/01%20Specification/AEO%20Category%20Coverage.md) requires an established absent trigger for exclusion; [C5](../../../AEO%20Scoring%20Vault/01%20Specification/AEO%20C5%20Consistency%20and%20Claim%20Support.md) excludes claim support when no material claims exist. Coverage and searches for absence must be documented under the [evidence contract](../../../AEO%20Scoring%20Vault/01%20Specification/AEO%20Assessment%20Evidence%20and%20Coverage.md).

The following source-level reference is frozen before model output. Numbers denote exact measured fractions; U denotes `not_measured`; NA denotes `not_applicable`. `U/NA*` permits only the specific predeclared absence with all proof in [approved-alternatives.json](approved-alternatives.json). These options do not imply that an unknown proves absence; if decoder or source evidence does not establish the exact absence, NA fails. Every other outcome remains exact. Shirt remains strict, complete and 78.125, with the underlying 15 reference findings below.

| Check | Running shoes | Daypack | PFD | Handbag | T-shirt |
| --- | --- | --- | --- | --- | --- |
| C1.identity | 1 | 1 | 1 | 1 | 1 |
| C1.explanation | 0.5 | U | 0.5 | U | 1 |
| C1.configuration | 0.5 | 0.5 | 0.5 | 0.5 | 1 |
| C2.essential | 1 | 11/12 | 1 | 1 | 1 |
| C2.supporting | U | 7/8 | 1 | 1 | 1 |
| C3.price | 1 | 1 | 1 | 1 | 1 |
| C3.availability | 1 | 1 | 1 | 1 | 1 |
| C3.shipping | U | U | U | U | 1 |
| C3.returns | U | U | U | U | 1 |
| C4.intended-use | 1 | 0.5 | 1 | 0.5 | 1 |
| C4.compatibility | 1 | 0.5 | 1 | 0.5 | 0.5 |
| C4.limitations | U/NA* | U | U | U/NA* | NA |
| C4.selection | 0.5 | 0.5 | 0.5 | 0.5 | 1 |
| C5.consistency | U | U | U | U | 1 |
| C5.claim-support | U/NA* | U/NA* | U | U/NA* | NA |

Selected size and color provide true partial configuration evidence: running q3/q7, daypack q6, PFD q3/q6 and handbag q5. No included item is stated, so each earns 0.5; original references omitted these roles and expected U. Shirt q4/q5 identifies selected configuration and included shirt and already earns 1. Width q4 in the running case describes width, but does not alone say a width choice was selected. The actual source and all observations are retained; headings and guides do not become values.

Running q12–q14 provide use, fit and sizing guidance; q2–q11 provide the referenced attributes, with lace closure unmeasured under the existing grader. Daypack q2–q14 provide the referenced attributes, audience, laptop-sleeve fit and capacity guidance; the dimensions do not specify exterior scope, and the laptop measurement lacks a diagonal/screen qualifier. PFD q2–q14 provide buoyancy, USCG approval, attributes, audience, torso fit and measurement guidance; rinse q10 is care. Handbag q2–q14 provide material, dimensions, carry, compartments, care, origin, audience, phone fit and selection guidance. The reference fractions describe existing anchors and are not a claim that all such policy choices are the only conceivable rubric implementation.

In the non-shirt cases q15/q16 are single price and availability statements, so no comparable pair is established and C5 consistency remains U. Their product regions are complete but policy coverage/discovery is unknown; no measured-zero C3 alternative is permitted. A directly available policy needs complete applicable source, not an inference from a missing link list. The shirt source contains the observed policy excerpts q23–q28 and distinct commercial statements q18–q20; its complete reference independently supports its strict results.

Running and handbag sources contain no trigger for their respective limitation conditions. Running, daypack and handbag sources contain no material claim requiring substantiation. Their source-bound NA alternatives require primary raw absent, decoded product-scope absent, complete non-truncated safe source, the exact category applicability rule, and independent source review; unknown remains permitted as conservative incompleteness. PFD q4 states USCG approval, a material certification claim, so no material-claim NA alternative is allowed. The daypack laptop-sleeve condition is present; do not infer that its fit condition is absent. PFD and pack limitation cases retain strict U because broad candidate/cue coverage does not establish the absence under the present decoder. Shirt's strict NA results require its independently established absent treatment and material-claim conditions and retain the existing follow-up and complete-score gate.

This adjudication does not approve an empty-facts result or suppress any supported required fact. Every raw slot, unselected ID, accepted fact, literal supplement and asserted absence is subject to the separate independent per-case review. Freeze and verify final request hashes before inference; the source hashes and only allowed alternate mappings are in the manifest. Any change in source, applicability rule or proof requires renewed pre-call review. R11 had zero provider invocations at adjudication.
