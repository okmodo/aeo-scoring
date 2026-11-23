// A delivery contains no user input: the durable row determines the next step.
export const AUDIT_QUEUE_PHASES = Object.freeze(['capture', 'prepare', 'assess']);
export const AUDIT_QUEUE_LEASE_MS = 120000;
export const AUDIT_QUEUE_RETRY_SECONDS = Math.ceil(AUDIT_QUEUE_LEASE_MS / 1000) + 1;
export const AUDIT_QUEUE_MAX_BATCH_SIZE = 1;
export const AUDIT_QUEUE_HORIZON_MS = 20 * 60 * 1000;

export function createAuditQueue({db, queue, reserveSend, runStep, finalize, messageFor, now = Date.now}) {
  const read = async id => db.prepare('SELECT * FROM audit_queue_jobs WHERE audit_id=?1').bind(id).first();
  const retry = message => message.retry({delaySeconds: AUDIT_QUEUE_RETRY_SECONDS});
  const finish = async (row, code) => {
    const t = now(), owner = crypto.randomUUID();
    const claimed = await db.prepare(`UPDATE audit_queue_jobs SET state='terminalizing',owner=?3,lease_until=?4,code=?5,updated_at=?2
      WHERE audit_id=?1 AND sequence=?6 AND state=?7 AND (owner IS NULL OR lease_until<=?2) RETURNING *`)
      .bind(row.audit_id,t,owner,t+AUDIT_QUEUE_LEASE_MS,code,row.sequence,row.state).first();
    if (!claimed) return false;
    try {
      await finalize({auditId: row.audit_id, phase: claimed.phase, code, owner, sequence: claimed.sequence});
      await db.prepare("UPDATE audit_queue_jobs SET state='complete',owner=NULL,lease_until=NULL,updated_at=?3 WHERE audit_id=?1 AND owner=?2 AND state='terminalizing'").bind(row.audit_id,owner,now()).run();
      return true;
    } catch (error) {
      await db.prepare("UPDATE audit_queue_jobs SET lease_until=?3,updated_at=?3 WHERE audit_id=?1 AND owner=?2 AND state='terminalizing'").bind(row.audit_id,owner,now()).run();
      throw error;
    }
  };
  const send = async row => {
    const t=now(), owner=crypto.randomUUID();
    const claimed=await db.prepare(`UPDATE audit_queue_jobs SET owner=?3,lease_until=?4,updated_at=?2
      WHERE audit_id=?1 AND sequence=?5 AND state='dispatching' AND (owner IS NULL OR lease_until<=?2) AND expires_at>?2 RETURNING *`)
      .bind(row.audit_id,t,owner,t+AUDIT_QUEUE_LEASE_MS,row.sequence).first();
    if (!claimed) return {accepted:false,finished:false};
    try {
      const reservation=await reserveSend();
      if (!reservation.accepted) {
        const released=await db.prepare("UPDATE audit_queue_jobs SET owner=NULL,lease_until=NULL,updated_at=?4 WHERE audit_id=?1 AND sequence=?2 AND state='dispatching' AND owner=?3 RETURNING *")
          .bind(row.audit_id,row.sequence,owner,now()).first();
        const finished=released ? await finish(released,'queue_budget_denied') : false;
        return {accepted:false,reason:reservation.reason || 'queue_budget_denied',finished};
      }
      await queue.send(messageFor ? await messageFor(row) : {auditId:row.audit_id,sequence:row.sequence});
      const confirmed=await db.prepare("UPDATE audit_queue_jobs SET state='waiting',owner=NULL,lease_until=NULL,updated_at=?4 WHERE audit_id=?1 AND sequence=?2 AND state='dispatching' AND owner=?3 RETURNING audit_id")
        .bind(row.audit_id,row.sequence,owner,now()).first();
      return {accepted:Boolean(confirmed),finished:false};
    } catch (error) {
      await db.prepare("UPDATE audit_queue_jobs SET owner=NULL,lease_until=NULL,updated_at=?4 WHERE audit_id=?1 AND sequence=?2 AND state='dispatching' AND owner=?3")
        .bind(row.audit_id,row.sequence,owner,now()).run();
      throw error;
    }
  };
  return {
    async start(auditId) {
      const t=now();
      const inserted=await db.prepare(`INSERT INTO audit_queue_jobs(audit_id,phase,sequence,state,updated_at,expires_at)
        SELECT id,'capture',0,'staged',?2,MIN(expires_at,?2+?3) FROM audits WHERE id=?1 AND status='pending' AND created_at<=?2 AND expires_at>?2
        ON CONFLICT(audit_id) DO NOTHING RETURNING audit_id`).bind(auditId,t,AUDIT_QUEUE_HORIZON_MS).first();
      const row=await read(auditId);
      if (!row || row.expires_at<=t || row.state==='complete') return {accepted:false,reason:'audit_not_pending'};
      if (!inserted) return row.state==='staged' ? {accepted:false,reason:'start_in_progress'} : {accepted:true,reason:'already_started'};
      let reservation;
      try { reservation=await reserveSend(); } catch (error) {
        await db.prepare("UPDATE audit_queue_jobs SET state='complete',code='queue_reservation_failed',updated_at=?2 WHERE audit_id=?1 AND state='staged'").bind(auditId,now()).run();
        throw error;
      }
      if (!reservation.accepted) {
        await db.prepare("UPDATE audit_queue_jobs SET state='complete',code='queue_budget_denied',updated_at=?2 WHERE audit_id=?1 AND state='staged'").bind(auditId,now()).run();
        return {accepted:false,reason:reservation.reason || 'queue_budget_denied'};
      }
      try {
        await queue.send({auditId:row.audit_id,sequence:row.sequence});
      } catch (error) {
        await db.prepare("UPDATE audit_queue_jobs SET state='complete',code='queue_send_failed',updated_at=?2 WHERE audit_id=?1 AND state='staged'").bind(auditId,now()).run();
        throw error;
      }
      const activated=await db.prepare("UPDATE audit_queue_jobs SET state='waiting',updated_at=?2 WHERE audit_id=?1 AND state='staged' AND expires_at>?2 RETURNING audit_id").bind(auditId,now()).first();
      if (!activated) return {accepted:false,reason:'audit_expired'};
      return {accepted:true};
    },
    async handle(batch,{deadLetter=false}={}) {
      for (const message of batch.messages) {
        const body=message.body;
        if (!body || typeof body.auditId!=='string' || !Number.isSafeInteger(body.sequence) || body.sequence<0) { message.ack(); continue; }
        try {
          let row=await read(body.auditId), t=now();
          if (!row || row.state==='complete' || body.sequence>row.sequence) { message.ack(); continue; }
          if (row.expires_at<=t) {
            const audit=await db.prepare("SELECT id FROM audits WHERE id=?1 AND status IN ('pending','incomplete') AND expires_at>?2").bind(row.audit_id,t).first();
            if (!audit) { message.ack(); continue; }
            if (await finish(row,'queue_deadline_exceeded')) message.ack(); else retry(message);
            continue;
          }
          if (row.state==='staged') {
            if (!deadLetter || !await finish(row,'queue_initial_dispatch_unconfirmed')) retry(message);
            else message.ack();
            continue;
          }
          if (row.state==='terminalizing') {
            if (row.lease_until>t) { retry(message); continue; }
            if (await finish(row,row.code || 'queue_delivery_exhausted')) message.ack(); else retry(message);
            continue;
          }
          if (deadLetter) {
            if (body.sequence<row.sequence && !(body.sequence===row.sequence-1 && row.state==='dispatching')) { message.ack(); continue; }
            if (await finish(row,'queue_delivery_exhausted')) message.ack(); else retry(message);
            continue;
          }
          if (body.sequence<row.sequence) {
            if (body.sequence===row.sequence-1 && row.state==='dispatching') {
              const result=await send(row);
              if (!result.accepted && !result.finished) { retry(message); continue; }
            }
            message.ack(); continue;
          }
          if (row.state==='dispatching') { retry(message); continue; }
          const owner=crypto.randomUUID();
          row=await db.prepare(`UPDATE audit_queue_jobs SET state='running',owner=?3,lease_until=?4,updated_at=?2
            WHERE audit_id=?1 AND sequence=?5 AND expires_at>?2 AND (state='waiting' OR (state='running' AND lease_until<=?2)) RETURNING *`)
            .bind(body.auditId,t,owner,t+AUDIT_QUEUE_LEASE_MS,body.sequence).first();
          if (!row) { retry(message); continue; }
          const result=await runStep({auditId:row.audit_id,phase:row.phase,owner,sequence:row.sequence,body});
          if (!result || ![null,'prepare','assess'].includes(result.next) || (row.phase==='capture' && result.next!==null && result.next!=='prepare') || (row.phase==='prepare' && result.next!==null && result.next!=='assess') || (row.phase==='assess' && result.next!==null && result.next!=='assess')) throw Error('invalid_queue_transition');
          t=now();
          if (result.next===null && result.code) {
            const released = await db.prepare("UPDATE audit_queue_jobs SET state='waiting',owner=NULL,lease_until=NULL,updated_at=?3 WHERE audit_id=?1 AND owner=?2 AND state='running' AND lease_until>?3 RETURNING *").bind(row.audit_id,owner,t).first();
            if (released && await finish(released,result.code)) message.ack(); else retry(message);
            continue;
          }
          const next=await db.prepare(`UPDATE audit_queue_jobs SET phase=COALESCE(?4,phase),sequence=sequence+1,state=CASE WHEN ?4 IS NULL THEN 'complete' ELSE 'dispatching' END,owner=NULL,lease_until=NULL,updated_at=?3
            WHERE audit_id=?1 AND owner=?2 AND state='running' AND lease_until>?3 AND expires_at>?3 RETURNING *`).bind(row.audit_id,owner,t,result.next).first();
          if (!next) { retry(message); continue; }
          if (result.next!==null) {
            const sent=await send(next);
            if (!sent.accepted && !sent.finished) { retry(message); continue; }
          }
          message.ack();
        } catch { retry(message); }
      }
    },
    async pending(auditId) { return read(auditId); }
  };
}
