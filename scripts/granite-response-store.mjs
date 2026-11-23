const expiresAfterMs = 86_400_000;
const encoder = new TextEncoder();
const sha = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const nullable = value => value ?? null;

export function createGraniteResponseStore(db) {
  const statement = (sql, ...params) => db.prepare(sql).bind(...params);
  const get = id => statement('SELECT * FROM model_attempts WHERE attempt_id=?1', id).first();

  return {
    async begin({ id, kind, capture, model, gateway, benchmark, now,
      promptVersion = benchmark.promptVersion, responseSchemaVersion = benchmark.responseSchemaVersion,
      requestBytes = benchmark.requestBytes }) {
      const expected = JSON.stringify(benchmark.questions.map(question => question.id));
      const digest = await sha(JSON.stringify([kind, capture?.auditId, capture?.sha256, model, gateway, promptVersion, responseSchemaVersion, requestBytes, benchmark.body,
        benchmark.questions, [...benchmark.evidenceById]]));
      await statement(`INSERT OR IGNORE INTO model_attempts
        (attempt_id,kind,audit_id,prepared_hash,model,gateway,stage,prompt_version,response_schema_version,
         input_digest,request_bytes,expected_question_ids_json,status,created_at,expires_at)
        VALUES (?1,?2,?3,?4,?5,?6,'binary_judgment',?7,?8,?9,?10,?11,'pending',?12,?13)`,
      id, kind, nullable(capture?.auditId), nullable(capture?.sha256), model, gateway,
      promptVersion, responseSchemaVersion, digest, requestBytes, expected, now, now + expiresAfterMs).run();
      const existing = await get(id);
      if (existing?.input_digest !== digest) throw new Error('model_attempt_conflict');
    },

    read: get,

    async capture(id, response) {
      const { outcome, httpStatus, modelElapsedMs, neurons, origin, bodyBase64, truncated } = response;
      const values = [outcome, nullable(httpStatus), nullable(modelElapsedMs), nullable(neurons),
        nullable(origin), nullable(bodyBase64), Number(truncated === true)];
      const digest = await sha(JSON.stringify(values));
      await statement(`UPDATE model_attempts SET status='received',outcome=?2,http_status=?3,model_elapsed_ms=?4,
        neurons=?5,response_origin=?6,response_body_base64=?7,response_truncated=?8,response_digest=?9
        WHERE attempt_id=?1 AND status='pending'`, id, ...values, digest).run();
      if ((await get(id))?.response_digest !== digest) throw new Error('model_response_conflict');
    },

    async finish(id, report) {
      const rows = JSON.stringify(report.findings.map(finding => [
        finding.id, finding.answer, finding.reason, finding.evidenceIds,
        finding.evidence, finding.validation, finding.points, finding.maxPoints,
      ]));
      const digest = await sha(JSON.stringify([rows, report.status, report.score]));
      await statement(`UPDATE model_attempts SET results_digest=?2
        WHERE attempt_id=?1 AND status='received' AND results_digest IS NULL`, id, digest).run();
      if ((await get(id))?.results_digest !== digest) throw new Error('model_results_conflict');
      // Single statement writes all question rows. The summary is published only
      // after every expected row exists and matches the deterministic replay.
      await statement(`INSERT OR IGNORE INTO model_question_results
        (attempt_id,question_id,answer,reason,evidence_ids_json,evidence_json,validation_status,points,max_points)
        SELECT ?1, json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'),
          json_extract(value,'$[3]'), json_extract(value,'$[4]'), json_extract(value,'$[5]'),
          json_extract(value,'$[6]'), json_extract(value,'$[7]') FROM json_each(?2)
        WHERE EXISTS (SELECT 1 FROM model_attempts WHERE attempt_id=?1 AND status='received')`, id, rows).run();
      await statement(`UPDATE model_attempts SET status=?2,measured=?3,unmeasured=?4,earned_points=?5,final_score=?6
        WHERE attempt_id=?1 AND status='received'
        AND json_array_length(expected_question_ids_json)=(
          SELECT COUNT(*) FROM model_question_results WHERE attempt_id=?1
        )`, id, report.status, report.measured, report.unmeasured, report.earnedPoints, report.score).run();
      const result = await get(id);
      if (result?.status !== report.status || result.measured !== report.measured ||
          result.unmeasured !== report.unmeasured || result.earned_points !== report.earnedPoints ||
          result.final_score !== report.score) throw new Error('model_results_conflict');
    },

    async prune(now) {
      await statement(`DELETE FROM model_attempts WHERE attempt_id IN (
        SELECT attempt_id FROM model_attempts WHERE expires_at<=?1 ORDER BY expires_at LIMIT 1
      )`, now).run();
    },
  };
}

// Retry an ambiguous storage failure once with the same attempt and bytes.
export async function retryModelWrite(write) {
  try { return await write(); }
  catch (error) {
    if (error.message.endsWith('_conflict')) throw error;
    return write();
  }
}
