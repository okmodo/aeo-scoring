import { scorePreparedProductStructure } from './prepared-product-structure.mjs';
import { scorePreparedPolicies } from './rubric-policy.mjs';
import { inspectPreparedPolicyLinks } from './browser-support.mjs';

const key = 'programmatic-structure-v1';

export function scorePreparedFindings(snapshot, derived) {
  const product = scorePreparedProductStructure(snapshot, derived);
  return { product, ...(product && { policies: scorePreparedPolicies(snapshot, derived) }) };
}

export async function prepareStructureFindings({
  input, derived, jobs, grant, inspectDomain, inspectPolicies = inspectPreparedPolicyLinks
}) {
  const saved = await jobs.checkpointRead(grant, key);
  if (saved?.status === 'completed') return saved.output;

  const prepared = scorePreparedFindings(input.snapshot, derived);
  // The domain observations are optional. An interrupted network attempt can
  // leave them unmeasured while prepared product facts remain available.
  if (saved) return prepared;

  const started = await jobs.checkpointStart(grant, key, grant.preparedHash);
  if (started.status === 'completed') return started.output;
  if (!started.created) return prepared;

  const { snapshot } = input;
  const kinds = ['shipping', 'returns'].filter(kind => prepared.policies?.['C3.' + kind]?.status === 'not_measured');
  const [support, linked] = await Promise.all([
    inspectDomain ? inspectDomain(snapshot.url).catch(() => ({})) : {},
    kinds.length && derived?.productHtml?.discoveryLinks?.length
      ? inspectPolicies(snapshot.url, derived.productHtml.discoveryLinks, { kinds }).catch(() => null)
      : null,
  ]);
  const findings = { ...prepared, support };
  if (linked) {
    const scored = scorePreparedPolicies(snapshot, derived, linked);
    for (const kind of kinds) findings.policies['C3.' + kind] = scored['C3.' + kind];
  }
  await jobs.checkpointComplete(grant, key, findings);
  return findings;
}

export async function readStructureFindings(db, auditId, preparedHash, now) {
  const row = await db.prepare(`SELECT output_json FROM prepared_assessment_checkpoints
    WHERE audit_id=?1 AND prepared_hash=?2 AND input_digest=?2
      AND checkpoint_key=?3 AND status='completed' AND expires_at>?4`)
    .bind(auditId, preparedHash, key, now).first();
  return row ? JSON.parse(row.output_json) : null;
}
