const MAX_LEASE_MS = 120000;
const MAX_ATTEMPTS = 5;
const fail = code => Object.assign(new Error('Prepared assessment job unavailable'), {code});
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const name = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const id = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function createPreparedAssessmentJobs(db, {now = Date.now} = {}) {
  if (!db?.prepare) throw fail('job_invalid');
  const clock = () => { const t=now(); if (!Number.isSafeInteger(t) || t<0) throw fail('job_invalid'); return t; };
  const valid = g => id(g?.auditId) && hash(g.preparedHash) && name(g.policyVersion) && name(g.owner);
  const args = g => [g.auditId,g.preparedHash,g.policyVersion];
  async function assertLease(g) {
    if (!valid(g)) throw fail('job_invalid');
    const row=await db.prepare(`SELECT j.* FROM prepared_assessment_jobs j JOIN retained_snapshots r ON r.audit_id=j.audit_id
      WHERE j.audit_id=?1 AND j.prepared_hash=?2 AND j.policy_version=?3 AND j.owner=?4 AND j.state='running' AND j.lease_until>?5
      AND r.state='ready' AND r.prepared_state='ready' AND r.prepared_hash=j.prepared_hash AND r.created_at<=?5 AND r.expires_at>?5`).bind(...args(g),g.owner,clock()).first();
    if (!row) throw fail('job_lease_lost');
    return true;
  }
  async function checkpointRead(g,key) {
    if (!name(key)) throw fail('job_invalid');
    await assertLease(g);
    await db.prepare(`UPDATE prepared_assessment_checkpoints SET status='uncertain',code='owner_lost',updated_at=?6 WHERE audit_id=?1 AND prepared_hash=?2 AND policy_version=?3 AND checkpoint_key=?4 AND status='started' AND owner<>?5 AND EXISTS(SELECT 1 FROM prepared_assessment_jobs j JOIN retained_snapshots r ON r.audit_id=j.audit_id WHERE j.audit_id=?1 AND j.prepared_hash=?2 AND j.policy_version=?3 AND j.owner=?5 AND j.state='running' AND j.lease_until>?6 AND r.state='ready' AND r.prepared_state='ready' AND r.prepared_hash=?2 AND r.created_at<=?6 AND r.expires_at>?6)`).bind(...args(g),key,g.owner,clock()).run();
    const r=await db.prepare('SELECT * FROM prepared_assessment_checkpoints WHERE audit_id=?1 AND prepared_hash=?2 AND policy_version=?3 AND checkpoint_key=?4').bind(...args(g),key).first();
    return r ? {status:r.status,inputDigest:r.input_digest,output:r.output_json===null?null:JSON.parse(r.output_json),code:r.code} : null;
  }
  return {
    async claim({auditId,preparedHash,policyVersion,leaseMs=30000}) {
      if (!id(auditId)||!hash(preparedHash)||!name(policyVersion)||!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>MAX_LEASE_MS) throw fail('job_invalid');
      const t=clock(), owner=crypto.randomUUID(), until=t+leaseMs;
      const r=await db.prepare(`INSERT INTO prepared_assessment_jobs(audit_id,prepared_hash,policy_version,state,owner,lease_until,attempts,updated_at,expires_at)
        SELECT audit_id,prepared_hash,?3,'running',?4,?5,1,?6,expires_at FROM retained_snapshots
        WHERE audit_id=?1 AND prepared_hash=?2 AND state='ready' AND prepared_state='ready' AND created_at<=?6 AND expires_at>?6
        ON CONFLICT(audit_id,prepared_hash,policy_version) DO UPDATE SET state='running',owner=excluded.owner,lease_until=excluded.lease_until,attempts=prepared_assessment_jobs.attempts+1,updated_at=excluded.updated_at,expires_at=excluded.expires_at
        WHERE ((prepared_assessment_jobs.state='running' AND prepared_assessment_jobs.lease_until<=?6) OR (prepared_assessment_jobs.state IN ('waiting','budget_wait') AND COALESCE(prepared_assessment_jobs.retry_at,0)<=?6)) RETURNING audit_id,attempts`).bind(auditId,preparedHash,policyVersion,owner,until,t).first();
      return r ? {auditId,preparedHash,policyVersion,owner,leaseUntil:until,terminalOnly:r.attempts>MAX_ATTEMPTS} : null;
    },
    assertLease, checkpointRead,
    async checkpointStart(g,key,inputDigest) {
      if (!name(key)||!hash(inputDigest)) throw fail('job_invalid');
      await assertLease(g);
      const inserted=await db.prepare(`INSERT INTO prepared_assessment_checkpoints(audit_id,prepared_hash,policy_version,checkpoint_key,input_digest,owner,status,updated_at,expires_at)
        SELECT ?1,?2,?3,?4,?5,?6,'started',?7,j.expires_at FROM prepared_assessment_jobs j WHERE j.audit_id=?1 AND j.prepared_hash=?2 AND j.policy_version=?3 AND EXISTS(SELECT 1 FROM prepared_assessment_jobs j JOIN retained_snapshots r ON r.audit_id=j.audit_id WHERE j.audit_id=?1 AND j.prepared_hash=?2 AND j.policy_version=?3 AND j.owner=?6 AND j.state='running' AND j.attempts<=5 AND j.lease_until>?7 AND r.state='ready' AND r.prepared_state='ready' AND r.prepared_hash=?2 AND r.expires_at>?7 AND r.created_at<=?7) ON CONFLICT DO NOTHING`).bind(...args(g),key,inputDigest,g.owner,clock()).run();
      const result=await checkpointRead(g,key);
      if (!result || result.inputDigest!==inputDigest) throw fail('checkpoint_mismatch');
      return {...result, created:inserted.meta.changes===1};
    },
    async checkpointComplete(g,key,output) {
      if (!name(key)) throw fail('job_invalid');
      let json; try {json=JSON.stringify(output);} catch {throw fail('job_invalid');}
      if (typeof json!=='string'||new TextEncoder().encode(json).length>65536) throw fail('job_invalid');
      const t=clock();
      const r=await db.prepare(`UPDATE prepared_assessment_checkpoints SET status='completed',output_json=?6,updated_at=?7 WHERE audit_id=?1 AND prepared_hash=?2 AND policy_version=?3 AND checkpoint_key=?4 AND owner=?5 AND status='started' AND EXISTS(SELECT 1 FROM prepared_assessment_jobs j JOIN retained_snapshots r ON r.audit_id=j.audit_id WHERE j.audit_id=?1 AND j.prepared_hash=?2 AND j.policy_version=?3 AND j.owner=?5 AND j.state='running' AND j.lease_until>?7 AND r.state='ready' AND r.prepared_state='ready' AND r.prepared_hash=?2 AND r.created_at<=?7 AND r.expires_at>?7)`).bind(...args(g),key,g.owner,json,t).run();
      if (r.meta.changes!==1) throw fail('job_lease_lost');
      return checkpointRead(g,key);
    },
    async checkpointFail(g,key,code,{uncertain=true}={}) {
      if (!name(key)||!name(code)) throw fail('job_invalid');
      await assertLease(g);
      // Only pre-call failures explicitly reported by the caller can be marked failed.
      const status = uncertain === false && ['admission_failed','deadline','request_limit'].includes(code) ? 'failed' : 'uncertain';
      const r=await db.prepare(`UPDATE prepared_assessment_checkpoints SET status=?8,code=?6,updated_at=?7 WHERE audit_id=?1 AND prepared_hash=?2 AND policy_version=?3 AND checkpoint_key=?4 AND owner=?5 AND status='started' AND EXISTS(SELECT 1 FROM prepared_assessment_jobs j JOIN retained_snapshots r ON r.audit_id=j.audit_id WHERE j.audit_id=?1 AND j.prepared_hash=?2 AND j.policy_version=?3 AND j.owner=?5 AND j.state='running' AND j.lease_until>?7 AND r.state='ready' AND r.prepared_state='ready' AND r.prepared_hash=?2 AND r.created_at<=?7 AND r.expires_at>?7)`).bind(...args(g),key,g.owner,code,clock(),status).run();
      if(r.meta.changes!==1) throw fail('job_lease_lost');
      return checkpointRead(g,key);
    },
    async release(g,{state,code=null,retryAt=null}) {
      if (!valid(g)||!['waiting','complete','failed','budget_wait','uncertain'].includes(state)||(code!==null&&!name(code))||(retryAt!==null&&(!Number.isSafeInteger(retryAt)||retryAt<0))) throw fail('job_invalid');
      const t=clock();
      const r=await db.prepare(`UPDATE prepared_assessment_jobs SET state=?5,code=?6,retry_at=?7,owner=NULL,lease_until=NULL,updated_at=?8,attempts=CASE WHEN ?5='waiting' AND ?6='checkpoint_yield' AND attempts<=5 THEN 0 ELSE attempts END WHERE audit_id=?1 AND prepared_hash=?2 AND policy_version=?3 AND owner=?4 AND state='running' AND lease_until>?8 AND EXISTS(SELECT 1 FROM retained_snapshots r WHERE r.audit_id=?1 AND r.state='ready' AND r.prepared_state='ready' AND r.prepared_hash=?2 AND r.created_at<=?8 AND r.expires_at>?8)`).bind(...args(g),g.owner,state,code,retryAt,t).run();
      if(r.meta.changes!==1) throw fail('job_lease_lost'); return true;
    },
    async discover({policyVersion,limit=25,now:at=clock()}={}) {
      if(!name(policyVersion)||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(at)||at<0) throw fail('job_invalid');
      const r=await db.prepare(`SELECT r.audit_id AS auditId,r.prepared_hash AS preparedHash FROM retained_snapshots r JOIN audits a ON a.id=r.audit_id AND a.status IN ('pending','incomplete') WHERE r.state='ready' AND r.prepared_state='ready' AND r.created_at<=?1 AND r.expires_at>?1 AND NOT EXISTS(SELECT 1 FROM prepared_assessment_jobs j WHERE j.audit_id=r.audit_id AND j.prepared_hash=r.prepared_hash AND j.policy_version=?3 AND (j.state IN ('complete','failed','uncertain') OR (j.state='running' AND j.lease_until>?1) OR (j.state IN ('waiting','budget_wait') AND j.retry_at>?1))) ORDER BY r.created_at LIMIT ?2`).bind(at,limit,policyVersion).all();
      return r.results;
    },
    async cleanup() {
      const t=clock();
      await db.prepare(`DELETE FROM prepared_assessment_checkpoints WHERE rowid IN (SELECT c.rowid FROM prepared_assessment_checkpoints c WHERE c.expires_at<=?1 ORDER BY c.expires_at LIMIT 100)`).bind(t).run();
      const r=await db.prepare(`DELETE FROM prepared_assessment_jobs WHERE rowid IN (SELECT j.rowid FROM prepared_assessment_jobs j WHERE j.expires_at<=?1 ORDER BY j.expires_at LIMIT 25)`).bind(t).run();
      return {deleted:r.meta.changes};
    },
  };
}
