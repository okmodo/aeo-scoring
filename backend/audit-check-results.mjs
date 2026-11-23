import rubric from '../config/rubric.v3.mjs';

const ids = new Set(rubric.criteria.flatMap(c => c.subchecks.map(s => s.id)));
const invalid = () => Object.assign(new Error('Invalid audit result'), {code:'invalid_audit_result'});
const time = n => Number.isSafeInteger(n) && n >= 0;

// The outbox and every component are committed in one D1 batch. The random
// write token prevents a later attempt from adding rows to an existing outbox.
export function createAuditResultStore(db) {
  if (!db?.prepare || !db?.batch) throw invalid();
  return {
    async stage(auditId,{grant,report,assessedUrl,now,sequence,owner,terminalizing=false}) {
      if (typeof auditId !== 'string' || (!terminalizing && (grant?.auditId !== auditId || !grant.preparedHash || !grant.policyVersion || !grant.owner)) || typeof owner !== 'string' || !time(now) || !time(sequence) || (!terminalizing && sequence < 1) || typeof assessedUrl !== 'string' || !['complete','incomplete'].includes(report?.status) || report.rubricVersion !== rubric.version || !Array.isArray(report.criteria)) throw invalid();
      const metadata=structuredClone(report), components=[];
      for (const criterion of metadata.criteria) {
        if (!Array.isArray(criterion.subchecks)) throw invalid();
        for (const row of criterion.subchecks) {
          if (!Array.isArray(row.components)) throw invalid();
          row.components=row.components.map(component => { components.push(component); return component.id; });
        }
      }
      if (components.length!==ids.size || new Set(components.map(c=>c.id)).size!==ids.size || components.some(c=>!ids.has(c.id))) throw invalid();
      const token=crypto.randomUUID();
      const statements=[
        db.prepare(`INSERT INTO audit_result_outbox(audit_id,sequence,status,report_json,assessed_url,checks_completed_at,expires_at,write_token)
          SELECT a.id,?2,?3,?4,?5,?6,a.expires_at,?7 FROM audits a
          WHERE a.id=?1 AND a.status='pending' AND a.expires_at>?6
          AND (?12=1 OR EXISTS(SELECT 1 FROM prepared_assessment_jobs j JOIN retained_snapshots r ON r.audit_id=j.audit_id
            WHERE j.audit_id=?1 AND j.prepared_hash=?8 AND j.policy_version=?9 AND j.owner=?10 AND j.state='running' AND j.lease_until>?6
            AND r.state='ready' AND r.prepared_state='ready' AND r.prepared_hash=j.prepared_hash AND r.created_at<=?6 AND r.expires_at>?6))
          AND EXISTS(SELECT 1 FROM audit_queue_jobs q WHERE q.audit_id=?1 AND q.owner=?11 AND q.lease_until>?6 AND ((?12=0 AND q.state='running' AND q.sequence=?2-1 AND q.expires_at>?6) OR (?12=1 AND q.state='terminalizing' AND q.sequence=?2)))
          ON CONFLICT(audit_id) DO NOTHING`).bind(auditId,sequence,report.status,JSON.stringify(metadata),assessedUrl,now,token,grant?.preparedHash ?? null,grant?.policyVersion ?? null,grant?.owner ?? null,owner,terminalizing ? 1 : 0),
        db.prepare(`INSERT INTO audit_check_results(audit_id,component_id,result_json)
          SELECT ?1,json_extract(value,'$.id'),value FROM json_each(?2)
          WHERE EXISTS(SELECT 1 FROM audit_result_outbox WHERE audit_id=?1 AND write_token=?3)`).bind(auditId,JSON.stringify(components),token),
        db.prepare(`UPDATE audits SET checks_completed_at=?2 WHERE id=?1 AND EXISTS(SELECT 1 FROM audit_result_outbox WHERE audit_id=?1 AND write_token=?3)`).bind(auditId,now,token),
      ];
      const result=await db.batch(statements);
      if (result[0].meta.changes===1) return true;
      const existing=await this.pending(auditId);
      return Boolean(existing && existing.sequence===sequence);
    },
    async pending(auditId) {
      const row=await db.prepare('SELECT sequence,status,checks_completed_at,expires_at,report_json FROM audit_result_outbox WHERE audit_id=?1').bind(auditId).first();
      if (!row) return null;
      return {sequence:row.sequence,status:row.status,checksCompletedAt:row.checks_completed_at,expiresAt:row.expires_at,rubricVersion:JSON.parse(row.report_json).rubricVersion};
    },
    async publish(auditId,{now,sequence,owner,terminalizing=false}) {
      if (typeof auditId !== 'string' || !time(now) || !time(sequence) || typeof owner !== 'string') throw invalid();
      const row=await db.prepare('SELECT * FROM audit_result_outbox WHERE audit_id=?1 AND expires_at>?2').bind(auditId,now).first();
      if (!row || !(row.sequence===sequence || (terminalizing && row.sequence===sequence+1))) return false;
      const records=await db.prepare('SELECT component_id,result_json FROM audit_check_results WHERE audit_id=?1').bind(auditId).all();
      if (records.results.length!==ids.size) throw invalid();
      const values=new Map(records.results.map(r=>[r.component_id,JSON.parse(r.result_json)]));
      const report=JSON.parse(row.report_json);
      for (const criterion of report.criteria) for (const subcheck of criterion.subchecks) subcheck.components=subcheck.components.map(id=>{if (!values.has(id)) throw invalid(); return values.get(id);});
      const result=await db.prepare(`UPDATE audits SET status=?2,report_json=?3,error_json=NULL,completed_at=?4,cache_until=MIN(?4+3600000,expires_at),assessed_url=?5
        WHERE id=?1 AND status='pending' AND expires_at>?4 AND EXISTS(SELECT 1 FROM audit_queue_jobs q WHERE q.audit_id=?1 AND q.sequence=?6 AND q.owner=?7 AND q.state=?8 AND q.lease_until>?4 AND (?8='terminalizing' OR q.expires_at>?4))
        AND EXISTS(SELECT 1 FROM audit_result_outbox o WHERE o.audit_id=?1 AND o.write_token=?9)`).bind(auditId,row.status,JSON.stringify(report),now,row.assessed_url,sequence,owner,terminalizing?'terminalizing':'running',row.write_token).run();
      if (result.meta.changes===1) return true;
      const audit=await db.prepare("SELECT status FROM audits WHERE id=?1 AND status=?2 AND report_json=?3").bind(auditId,row.status,JSON.stringify(report)).first();
      return Boolean(audit);
    },
  };
}
