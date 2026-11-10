import { actions, checks, total } from "../sample";

// Frozen, fictional presentation scenarios. Only the complete example is scored.
export const scenarios = {
  complete: {
    label: "Complete",
    status: "Assessment complete",
    description: "All rubric checks are represented in this fictional example.",
    score: total("structure") + total("content"),
    structure: total("structure"),
    content: total("content"), checks, actions
  },
  incomplete: {
    label: "Incomplete",
    status: "Assessment incomplete",
    description: "In this fictional example, page retrieval stopped at the size limit after 3 of 40 checks were inspected. The other 37 checks remain unmeasured. A complete page inspection is needed before calculating a final score.",
    score: null,
    structure: null,
    content: null,
    checks: checks.slice(0, 3),
    actions: []
  },
  zero: {
    label: "Zero checks",
    status: "No checks completed",
    description: "In this fictional example, the assessment stopped before any checks ran. Retry the assessment to gather results.",
    score: null,
    structure: null,
    content: null,
    checks: [],
    actions: []
  },
  unavailable: {
    label: "Unavailable",
    status: "Unable to assess",
    description: "In this fictional example, the product page could not be retrieved. Check that the page is accessible, then retry the assessment.",
    score: null,
    structure: null,
    content: null,
    checks: [],
    actions: []
  },
} as const;
export type Scenario = keyof typeof scenarios;
