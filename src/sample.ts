import rubric from "../config/rubric.v1.json" with { type: "json" };
export const essentialAttributes = [1, 0, 1, 0, 0, 1];
export const attributeDelivery = [1, 0, 1, 0, 0, 1, 0.5, 0.5, 0.5, 0.5];
const average = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / values.length;
export const deductions: Record<string, number> = {
  "S1.specifications": 3 * (1 - average(attributeDelivery)),
  "S7.identity": 0.5,
  "S7.links": 0.5,
  "S8.context": 0.5,
  "S8.guidance": 0.5,
  "C2.essential": 14 * (1 - average(essentialAttributes)),
  "C3.shipping": 3,
  "C4.limitations": 2,
};
export const checks = rubric.criteria.flatMap((c) =>
  c.subchecks.map((s) => ({
    ...s,
    pillar: c.pillar,
    awarded: s.maxPoints - (deductions[s.id] ?? 0),
  })),
);
export const total = (pillar: string) =>
  checks.filter((c) => c.pillar === pillar).reduce((n, c) => n + c.awarded, 0);
export const actions = [
  {
    title: "Complete and publish the specifications",
    owner: "Catalog / data",
    support: "Web team",
    ids: ["C2.essential", "S1.specifications"],
    points: 8.5,
    evidence:
      "The fictional page shows selected size, running surface and color, but omits width, upper material and outsole material: 3 of 6 essential attributes are complete. Four supporting attributes are available only after rendering, so raw delivery is 3 initial + 4 half-credit rendered + 3 absent, or 5 / 10.",
    change:
      "Confirm missing attributes, then publish all applicable specifications as readable initial HTML.",
    condition:
      "Up to +8.5: +7 for complete essential attributes and +1.5 for all applicable specifications being readable to a simple fetcher.",
    dependency:
      "Catalog confirmation and web publishing are both required for this combined outcome.",
  },
  {
    title: "Explain shipping before checkout",
    owner: "Content",
    support: "Site operations",
    ids: ["C3.shipping"],
    points: 3,
    evidence:
      "The fictional product page has no shipping cost or timing information.",
    change:
      "Publish applicable shipping costs and delivery timing, or link to an accessible policy that clearly applies.",
    condition:
      "Up to +3 when complete applicable shipping information is available on the page or in an inspected, applicable linked policy.",
    dependency: "Confirm current shipping terms.",
  },
  {
    title: "Add useful product limitations",
    owner: "Content",
    support: "Catalog / data",
    ids: ["C4.limitations"],
    points: 2,
    evidence:
      "The fictional page claims water resistance but does not explain its limits.",
    change:
      "Verify and publish meaningful limitations; do not invent product claims.",
    condition: "Up to +2 when relevant limitations are verified and clear.",
    dependency: "Confirm limitations with the catalog team.",
  },
  {
    title: "Consider an llms.txt file",
    owner: "Site operations",
    support: "Content",
    ids: ["S7.identity", "S7.links"],
    points: 1,
    evidence: "No llms.txt file exists in this invented example.",
    change:
      "Decide whether to publish a file identifying the site and linking to useful resources.",
    condition: "Up to +1 after a qualifying file is published and accessible.",
    dependency: "A decision to publish and maintain the file.",
  },
  {
    title: "Consider a website agent guide",
    owner: "Site operations",
    support: "Content",
    ids: ["S8.context", "S8.guidance"],
    points: 1,
    evidence: "No website agent guide exists in this invented example.",
    change:
      "Decide whether to publish a guide with site context and agent guidance.",
    condition: "Up to +1 after a qualifying guide is published and accessible.",
    dependency: "A decision to publish and maintain the guide.",
  },
].sort(
  (a, b) =>
    (a.ids[0].startsWith("S7") || a.ids[0].startsWith("S8") ? 1 : 0) -
      (b.ids[0].startsWith("S7") || b.ids[0].startsWith("S8") ? 1 : 0) ||
    b.points - a.points,
);
