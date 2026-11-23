// Presentation groups combine components without changing their scoring criteria.
export const RUBRIC_V3_GROUPS = [
  { id:'S1', pillar:'structure', rows:[
    ['S1.readable-html','S1.delivery','S1.readability'], ['S1.scope','S1.scope'],
    ['S1.configuration','S1.configuration'], ['S1.supporting-access','S1.supporting-access'],
  ]},
  { id:'S2', pillar:'structure', rows:[
    ['S2.product-markup','S2.json-ld','S2.syntax'], ['S2.product-identity','S2.entity','S2.variants','S3.identity'],
    ['S2.offer-agreement','S2.offer','S3.price','S3.availability'], ['S2.identifiers','S2.identifiers'],
    ['S2.optional-claims','S3.optional-claims'],
  ]},
  { id:'S4', pillar:'structure', rows:[['S4.page-labels','S4.title','S4.organization'],['S4.image-alternatives','S4.image-alternatives']]},
  { id:'S5', pillar:'structure', rows:[['S5.crawler-access','S5.search','S5.ai-retrieval'],['S5.sitemap','S6.usable','S6.inclusion'],['S5.llms-txt','S7.identity','S7.links']]},
  { id:'C1', pillar:'content', rows:[
    ['C1.identity-explanation','C1.identity','C1.explanation'], ['C1.options-selection','C1.configuration','C4.selection'],
    ['C1.essential-specs','C2.essential'], ['C1.supporting-details','C2.supporting','C4.limitations'],
    ['C1.use-compatibility','C4.intended-use','C4.compatibility'],
  ]},
  { id:'C3', pillar:'content', rows:[['C3.price-stock','C3.price','C3.availability'],['C3.shipping','C3.shipping'],['C3.returns','C3.returns']]},
  { id:'C5', pillar:'content', rows:[['C5.consistency','C5.consistency'],['C5.claim-support','C5.claim-support']]},
];

const GROUP_ACTIONS = {
  S1:['Make the product page readable','Web developer'],
  S2:['Publish accurate product structured data','Web developer'],
  S4:['Make details easy to find','Content editor'],
  S5:['Make the page discoverable','Web developer'],
  C1:['Explain the product and help shoppers choose','Product specialist'],
  C3:['Make buying terms clear','Commerce team'],
  C5:['Resolve conflicting facts and support claims','Product specialist'],
};

const unique = values => [...new Set(values.filter(Boolean))];
const sum = values => values.reduce((a,b) => a + b, 0);

export function presentRubricV3(report) {
  const source = new Map(report.criteria.flatMap(c => c.subchecks.map(s => [s.id, s])));
  const componentToRow = new Map();
  const criteria = RUBRIC_V3_GROUPS.map(group => {
    const subchecks = group.rows.map(([id,...ids]) => {
      const components = ids.map(componentId => {
        componentToRow.set(componentId, {group:group.id, row:id});
        const component = source.get(componentId);
        if (!component) throw new Error(`Missing rubric component ${componentId}`);
        return {...component, availablePoints: component.availablePoints ?? (component.status === 'not_applicable' ? 0 : component.maxPoints)};
      });
      const availablePoints = sum(components.map(c => c.availablePoints));
      const earnedPoints = sum(components.map(c => c.points ?? 0));
      const status = components.every(c => c.status === 'not_applicable') ? 'not_applicable' :
        components.some(c => c.status === 'not_measured') ? 'not_measured' : 'measured';
      return { id, maxPoints:sum(components.map(c => c.maxPoints)), availablePoints, status,
        fraction: status === 'measured' && availablePoints ? earnedPoints / availablePoints : null,
        points: status === 'measured' ? earnedPoints : null, earnedPoints,
        evidenceIds:unique(components.flatMap(c => c.evidenceIds || [])),
        reason:unique(components.filter(c => c.status !== 'measured').map(c => c.reason)).join(' ') || null,
        components };
    });
    const complete = subchecks.every(c => c.status !== 'not_measured') &&
      // An entirely excluded original criterion still cannot produce a score.
      group.rows.flatMap(row => row.slice(1)).every(id => {
        const criterion = report.criteria.find(c => c.subchecks.some(s => s.id === id));
        return criterion?.complete === true;
      });
    return { id:group.id, pillar:group.pillar, maxPoints:sum(subchecks.map(c => c.maxPoints)),
      points:sum(subchecks.map(c => c.earnedPoints)), complete, subchecks };
  });
  const fixesByGroup = new Map();
  for (const fix of report.fixes || []) {
    const byGroup = new Map();
    for (const componentId of fix.checkIds || []) {
      const mapping = componentToRow.get(componentId);
      if (!mapping) continue;
      const entries = byGroup.get(mapping.group) || [];
      entries.push({componentId, row:mapping.row});
      byGroup.set(mapping.group, entries);
    }
    for (const [groupId, entries] of byGroup) {
      const existing = fixesByGroup.get(groupId) || {id:`improve-${groupId.toLowerCase()}`, title:GROUP_ACTIONS[groupId][0], owner:GROUP_ACTIONS[groupId][1], checkIds:[], evidenceIds:[], conditions:[], componentIds:[], unresolved:false};
      existing.unresolved ||= fix.recoverablePoints == null;
      existing.checkIds.push(...entries.map(e => e.row));
      existing.componentIds.push(...entries.map(e => e.componentId));
      existing.evidenceIds.push(...(fix.evidenceIds || []));
      existing.conditions.push(fix.condition);
      fixesByGroup.set(groupId, existing);
    }
  }
  const fixes = [...fixesByGroup.values()].map(({conditions,componentIds,unresolved,...fix}) => {
    const components = unique(componentIds).map(id => source.get(id));
    return {...fix, checkIds:unique(fix.checkIds), evidenceIds:unique(fix.evidenceIds),
      condition:unique(conditions).join(' '),
      recoverablePoints:unresolved || components.some(c => c.status === 'not_measured') ? null :
        sum(components.filter(c => c.status === 'measured').map(c => (c.availablePoints ?? c.maxPoints) - (c.points ?? 0)))};
  }).sort((a,b) => (b.recoverablePoints ?? -1) - (a.recoverablePoints ?? -1));
  const rows = criteria.flatMap(c => c.subchecks);
  return {...report, criteria, fixes, coverage:{...report.coverage,
    measured:rows.filter(c => c.status === 'measured').length,
    notMeasured:rows.filter(c => c.status === 'not_measured').length,
    notApplicable:rows.filter(c => c.status === 'not_applicable').length, total:rows.length}};
}
