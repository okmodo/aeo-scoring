import { scorePreparedProductStructure } from './prepared-product-structure.mjs';

const key = 'programmatic-structure-v1';

export async function prepareStructureFindings({ input, derived, jobs, grant, inspectDomain }) {
  const saved = await jobs.checkpointRead(grant, key);
  if (saved?.status === 'completed') return saved.output;

  const product = scorePreparedProductStructure(input.snapshot, derived);
  // The domain observations are optional. An interrupted network attempt can
  // leave them unmeasured while prepared product facts remain available.
  if (saved) return { product };

  const started = await jobs.checkpointStart(grant, key, grant.preparedHash);
  if (started.status === 'completed') return started.output;
  if (!started.created) return { product };

  const support = inspectDomain ? await inspectDomain(input.snapshot.url).catch(() => ({})) : {};
  const findings = { product, support };
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
