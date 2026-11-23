// Only explicitly recognized milestones leave the authenticated API.
const order = ['retrieval','preparation','assessment','scoring'];
export function auditProgress({auditId, queue, pipeline, prepared, retained, work, status, report, checksCompletedAt}) {
  if (typeof auditId !== 'string' || !queue || !Number.isSafeInteger(queue.sequence) || queue.sequence < 0 || queue.sequence > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) return undefined;
  let records;
  try { records = pipeline ? JSON.parse(pipeline) : []; } catch { return undefined; }
  if (!Array.isArray(records) || records.length > 16) return undefined;
  const states = Object.fromEntries(order.map(x=>[x,[]]));
  const add = (stage, value) => {
    if (value !== 'running') states[stage] = states[stage].filter(x=>x==='running');
    if (!states[stage].includes(value)) states[stage].push(value);
  };
  for (const item of records) {
    if (!item || typeof item.code !== 'string') continue;
    if (item.stage==='retrieval' && item.code==='browser_loading' && item.status==='running') add('retrieval','running');
    if (item.stage==='preparation' && item.code==='preparation_started' && item.status==='running') add('preparation','running');
    if (item.stage==='content' && item.code==='facts_preparing' && item.status==='running') add('assessment','running');
    if (item.stage==='content' && ['judgments_validated','judgments_recovered'].includes(item.code) && item.status==='completed') add('assessment','completed');
    if (item.stage==='content' && ['failed','skipped'].includes(item.status)) add('assessment',item.status);
    if (item.stage==='scoring' && item.code==='report_building' && item.status==='running') add('scoring','running');
    if (item.stage==='scoring' && ['report_complete','report_incomplete'].includes(item.code) && item.status==='completed' && checksCompletedAt != null) add('scoring','completed');
  }
  // The stored provider response alone can be an origin error page. Work readiness
  // is written only after status validation; prepared readiness also proves usability.
  const usable = retained==='ready' && (['ready','assessing','finished'].includes(work) || prepared==='ready');
  if (usable) { add('retrieval','running'); add('retrieval','completed'); }
  if (prepared==='ready' && retained==='ready') { add('preparation','running'); add('preparation','completed'); }
  const published = ['complete','incomplete'].includes(status) && report != null;
  if (published) {
    const interrupted = queue.phase === 'prepare' ? 'preparation' : 'assessment';
    if (status === 'incomplete' && !states[interrupted].some(value=>value !== 'running')) add(interrupted,'failed');
    add('scoring','running'); add('scoring','completed');
  } else if (status === 'unable_to_assess') {
    add(queue.phase === 'capture' ? 'retrieval' : queue.phase === 'prepare' ? 'preparation' : 'assessment','failed');
  }
  const events = [];
  for (const [index,stage] of order.entries()) for (const [offset,state] of ['running','completed','skipped','failed'].entries()) {
    if (states[stage].includes(state)) events.push({sequence:index*4+offset+1,stage,status:state});
  }
  return {version:'1',auditId,revision:queue.sequence*1000+records.length*16+(usable?4:0)+(prepared==='ready' && retained==='ready'?2:0)+(checksCompletedAt != null?1:0)+(status!=='pending'?1:0),events};
}
