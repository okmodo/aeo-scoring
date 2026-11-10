// Frozen fictional field recommendations, grounded in the sample action evidence.
export const fieldGroups = [
  {
    action: "Complete and publish the specifications",
    fields: [
      {
        name: "Width",
        finding: "Missing from the fictional product page.",
        edit: "Width: [verified width]",
        publish: "Product specifications in initial HTML",
        owner: "Catalog / data and web team",
        verify: "Confirm the selected variant's width and applicable terminology.",
      },
      {
        name: "Upper material",
        finding: "Missing from the fictional product page.",
        edit: "Upper material: [verified upper material]",
        publish: "Product specifications in initial HTML",
        owner: "Catalog / data and web team",
        verify: "Confirm the material with the catalog team.",
      },
      {
        name: "Outsole material",
        finding: "Missing from the fictional product page.",
        edit: "Outsole material: [verified outsole material]",
        publish: "Product specifications in initial HTML",
        owner: "Catalog / data and web team",
        verify: "Confirm the material with the catalog team.",
      },
      {
        name: "Rendered-only supporting attributes (4 fields)",
        finding: "Four supporting attributes are available only after rendering in the fictional example; their identities and values are not recorded.",
        edit: "[verified field label]: [verified existing value and unit, where applicable]",
        publish: "Product specifications in initial HTML",
        owner: "Catalog / data and web team",
        verify: "First identify the affected fields by comparing rendered specifications with initial HTML. Confirm the existing values, then publish them in initial HTML.",
      },
    ],
  },
  {
    action: "Explain shipping before checkout",
    fields: [
      {
        name: "Shipping cost",
        finding: "No shipping cost information appears on the fictional product page.",
        edit: "Shipping cost: [verified applicable shipping cost or policy]",
        publish: "Product page or an accessible, applicable linked policy",
        owner: "Content and site operations",
        verify: "Confirm current costs, conditions and applicability.",
      },
      {
        name: "Delivery timing",
        finding: "No delivery timing information appears on the fictional product page.",
        edit: "Delivery timing: [verified applicable delivery timing or policy]",
        publish: "Product page or an accessible, applicable linked policy",
        owner: "Content and site operations",
        verify: "Confirm current timing, conditions and applicability.",
      },
    ],
  },
  {
    action: "Add useful product limitations",
    fields: [
      {
        name: "Water-resistance limits",
        finding: "The fictional page claims water resistance without explaining its limits.",
        edit: "Water resistance: [verified scope and limitations]",
        publish: "Product description or nearby specifications",
        owner: "Content and catalog / data",
        verify: "Confirm meaningful limitations with the catalog team; do not invent a claim.",
      },
    ],
  },
  {
    action: "Consider an llms.txt file",
    fields: [
      {
        name: "Site identity",
        finding: "No llms.txt file exists in the fictional example.",
        edit: "# [verified site name]\n[verified site description]",
        publish: "A qualifying, accessible llms.txt file, if the team chooses to maintain one",
        owner: "Site operations and content",
        verify: "Decide whether to maintain the file and confirm the site's identity.",
      },
      {
        name: "Resource links",
        finding: "No llms.txt file exists in the fictional example.",
        edit: "- [verified resource title]([verified accessible resource URL])",
        publish: "A qualifying, accessible llms.txt file, if the team chooses to maintain one",
        owner: "Site operations and content",
        verify: "Confirm the links are useful, accessible and maintained.",
      },
    ],
  },
  {
    action: "Consider a website agent guide",
    fields: [
      {
        name: "Site context",
        finding: "No website agent guide exists in the fictional example.",
        edit: "Site context: [verified site purpose and scope]",
        publish: "A qualifying, accessible website agent guide, if the team chooses to maintain one",
        owner: "Site operations and content",
        verify: "Decide whether to maintain the guide and confirm the context.",
      },
      {
        name: "Agent guidance",
        finding: "No website agent guide exists in the fictional example.",
        edit: "Agent guidance: [verified applicable guidance]",
        publish: "A qualifying, accessible website agent guide, if the team chooses to maintain one",
        owner: "Site operations and content",
        verify: "Confirm that the guidance is accurate and maintainable.",
      },
    ],
  },
] as const;
