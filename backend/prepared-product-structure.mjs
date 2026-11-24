import { isPreparedObservations } from './prepared-derived.mjs';
import { inspectProductJsonLdPresence, inspectRevisedProductSchema } from './structure-schema.mjs';
import { assessStructure } from './structure-assessment.mjs';
import { assessContent } from './content-assessment.mjs';

const ids = ['S2.json-ld','S2.syntax','S2.entity','S2.variants','S2.offer','S2.identifiers','S3.identity','S3.price','S3.availability','S3.optional-claims'];

// Consume the already-derived, verified prepared page; do not re-extract HTML.
export function scorePreparedProductStructure(snapshot, derived) {
  if (!isPreparedObservations(derived, snapshot)) return null;
  const schema = inspectRevisedProductSchema(snapshot, derived, { prepared: true });
  // A ProductGroup association does not establish the current variant or its
  // comparison fields. Only the group-name comparison below is applicable.
  const structure = schema.group ? {} : assessStructure(snapshot, derived, { schema,
    content: assessContent(snapshot, derived, { product: schema.product }) });
  const observations = { ...schema.findings, ...structure,
    'S2.json-ld': inspectProductJsonLdPresence(snapshot, derived) };
  const heading = typeof derived.productHtml?.identity === 'string' ? derived.productHtml.identity : derived.productHtml?.identity?.mainH1 ?? derived.productHtml?.headings?.find(heading => heading.level === 1)?.text;
  if (schema.group && typeof heading === 'string' && typeof schema.group.name === 'string') {
    const norm = value => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    observations['S3.identity'] = { status:'measured', fraction: norm(heading) === norm(schema.group.name) ? 1 : 0,
      url:snapshot.url, location:'product h1; associated ProductGroup.name', excerpt:`Product heading: ${heading}; structured group name: ${schema.group.name}.` };
  }
  return Object.fromEntries(ids.map(id => [id, observations[id] ?? { status: 'not_measured', reason: 'The prepared page did not establish this structured-data finding.' }]));
}
