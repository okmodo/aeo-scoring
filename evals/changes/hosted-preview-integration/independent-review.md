# Independent preview review

Status: source review substantially complete; approval pending exact-commit hosted CI, independent browser checks and fresh-agent continuation. Review of the integration worktree against rubric v1, category registry, reference scorer and report vault. This is a synthetic sample, not a live audit.

The sample uses the supported running-shoe category. Its 84.5/100 score comprises Structure 36.5/40 and Content 48/60. S1 specifications average delivery over all ten category attributes, and C2 essential averages all six essentials. The water-resistance claim makes the C4 limitations check applicable; the sample describes fictional claim support. All 13 criteria's subchecks are shown. The sample discloses that no real source or entered URL is assessed.

The combined catalog/web specification action avoids double-counting overlapping work; recovery is conditional and actions are ranked with emerging practices last. The tests now import actual sample data, compare with the reference scorer, validate attribute counts and render the component at runtime. The CI collector registers preview tests and rejects placeholder commands. Review did not inspect a live deployment or independently execute browser tests.

Process exception: the original plan at 9ddb885 had an invalid scope pattern and prototype work began before a valid plan was committed. Integration plan 1bbd83d was committed separately before further integration. The preserved original plan and process-deviation.md disclose this; the new plan does not retroactively satisfy AGENTS.md's literal plan-before-implementation requirement for the prototype. The PR must preserve and disclose the exception rather than claim complete process compliance.

Cloudflare deployment, hosted CI, browser accessibility, fresh-agent continuation, and final committed source remain to be verified. This interim review is not approval to publish.

Source was subsequently committed as 98807ba1e2c39ccce4f07d4f82c9ab754c8214c9. Local independent `npm run lint` and `npm run test:preview` passed. The minimatch override installs v11.0.4 for three development-tool consumers whose declarations require v10; the observed constructor/function exports exist and lint passed, but this is an unsupported major override, and passing lint does not establish full compatibility. Prefer a compatible patched release where available, or disclose the residual development dependency risk.
