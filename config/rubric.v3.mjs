import rubricV2 from './rubric.v2.json' with { type: 'json' };

// Scoring criteria retain their v2 boundaries so exclusions redistribute within
// the same denominator. JSON-LD has its own fixed point, independent of S2.
export const rubricV3 = {
  ...rubricV2,
  version: '3.0.0',
  criteria: rubricV2.criteria.map(criterion => criterion.id !== 'S8' ? criterion : {
    id: 'S2-json-ld', pillar: 'structure', maxPoints: 1,
    basis: 'documented_platform_requirement',
    subchecks: [{ id: 'S2.json-ld', maxPoints: 1,
      full: 'On-page initial or rendered HTML contains parseable Schema.org Product or ProductGroup JSON-LD.',
      zero: 'Complete inspection establishes no parseable Schema.org Product or ProductGroup JSON-LD.',
      applicability: 'Always applicable to a supported product-page audit.', method: 'deterministic',
      sourceUrls: ['https://schema.org/Product'] }],
  }),
};
export default rubricV3;
