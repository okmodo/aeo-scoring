// Public progress contains fixed labels only; retained diagnostics never leave the API.
const mapping = {retrieval:'retrieval', preparation:'preparation', category:'assessment', content:'assessment', scoring:'scoring'};
const order = ['retrieval','preparation','assessment','scoring'];
export function auditProgress({auditId, queue, pipeline, prepared, status, report}) {
  if (!queue || !Number.isSafeInteger(queue.sequence) || queue.sequence < 0) return undefined;
  let records;
  try { records = pipeline ? JSON.parse(pipeline) : []; } catch { return undefined; }
  if (!Array.isArray(records) || records.length > 16) return undefined;
  const states = Object.fromEntries(order.map(x=>[x,[]]));
  const add = (stage, value) => {
    // Retain the start, but expose only the latest durable outcome after recovery.
    if (value !== 'running') states[stage] = states[stage].filter(x=>x==='running');
    if (!states[stage].includes(value)) states[stage].push(value);
  };
  for (const item of records) {
    const stage = mapping[item?.stage];
    if (!stage || !['running','completed','failed','skipped'].includes(item.status)) continue;
    if ((stage === 'scoring' && item.status === 'completed') || (item.stage === 'category' && item.status === 'completed')) continue;
    add(stage,item.status);
  }
  // Durable readiness survives a worker stopping between preparation and its marker.
  if (prepared === 'ready') { add('preparation','running'); add('preparation','completed'); }
  const published = ['complete','incomplete'].includes(status) && report != null;
  if (published) {
    const interrupted = queue.phase === 'prepare' ? 'preparation' : 'assessment';
    if (status === 'incomplete' && !states[interrupted].some(value=>value !== 'running')) add(interrupted,'failed');
    add('scoring','running'); add('scoring','completed');
  } else if (status === 'unable_to_assess') {
    add(queue.phase === 'capture' ? 'retrieval' : queue.phase === 'prepare' ? 'preparation' : 'assessment','failed');
  }
  const events = [];
  for (const [index,stage] of order.entries()) {
    for (const [offset,state] of ['running','completed','skipped','failed'].entries()) {
      if (states[stage].includes(state)) events.push({sequence:index*4+offset+1,stage,status:state});
    }
  }
  return {version:'1',auditId,revision:queue.sequence*100+records.length*3+(prepared==='ready'?1:0)+(status!=='pending'?2:0),events};
}
