import { assessRetainedRubric } from './ai-rubric-assessment.mjs';
import { prepareAssessmentSources } from './assessment-sources.mjs';

const encoder = new TextEncoder();
const MAX_STEPS = 128;
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value))))].map(x => x.toString(16).padStart(2, '0')).join('');
class Stop extends Error {
  constructor(code) { super(code); this.code = code; this.resumableAssessment = true; }
}

// This is a conservative ceiling, not a prediction of dynamic model output.
// The same prepared sources are inspected in several separately charged stages.
export async function planPreparedAssessment({preparedInput}) {
  const snapshot=preparedInput?.snapshot, extracted=preparedInput?.extracted;
  if (snapshot?.preprocessing?.representation !== 'cleaned_rendered_html' || snapshot?.preprocessing?.version !== 'simplified-html-v1') throw new TypeError('invalid_prepared_input');
  const bundle=await prepareAssessmentSources(snapshot,extracted);
  if (!bundle.coverage.preparedHtml || !bundle.coverage.complete) throw new TypeError('invalid_prepared_input');
  const batches=sources=>{const result=[];for (const source of sources) {const last=result.at(-1);if (!last || encoder.encode(JSON.stringify([...last,source])).length>18000) result.push([source]);else last.push(source);}return result.length;};
  const productBatches=batches(bundle.sources.filter(s=>s.scope==='product' && s.origin==='rendered' && s.kind==='html' && s.preparedHtml));
  const inspectionBatches=batches(bundle.sources);
  // Product extraction, identity, proposal, optional review, inspection,
  // optional support inspection, and final judgment. Support/review depend on output.
  const potentialCalls=productBatches+inspectionBatches*2+4;
  const requestBytesLimit=60*1024, outputTokensLimit=4000;
  const neuronsPerCallUpperBound=Math.ceil((requestBytesLimit+2048)*26668/1e6+outputTokensLimit*204805/1e6)+64;
  return {sourceBytes:bundle.coverage.bytes,sourceSections:bundle.sources.length,productBatches,inspectionBatches,potentialCalls,maxCalls:MAX_STEPS,requestBytesLimit,outputTokensLimit,neuronsPerCallUpperBound,neuronsUpperBound:Math.min(potentialCalls,MAX_STEPS)*neuronsPerCallUpperBound,withinCallLimit:potentialCalls<=MAX_STEPS,estimate:'conservative ceiling; conditional review and support inspection depend on model output; every actual request is separately reserved'};
}

// A checkpoint is persisted before invoking the canonical admission and model
// call. A started/uncertain step is never automatically charged again.
export async function runPreparedAssessmentStep({grant,jobs,preparedInput,AI,allowance,now=Date.now,onProfile,deadlineAt,calibrationApproved}) {
  if (!grant || !jobs) return {status:'unavailable',code:'invalid_prepared_input'};
  try { await planPreparedAssessment({preparedInput}); } catch { return {status:'unavailable',code:'invalid_prepared_input'}; }
  let index=0, invoked=false;
  const modelCall=async (args, execute) => {
    if (++index > MAX_STEPS) throw new Stop('model_step_limit');
    const key=String(index).padStart(4,'0'), inputDigest=await digest(args.input);
    const existing=await jobs.checkpointRead(grant,key);
    if (existing) {
      if (existing.inputDigest!==inputDigest) throw new Stop('checkpoint_input_mismatch');
      if (existing.status==='completed') return existing.output;
      throw new Stop(existing.code || 'model_usage_uncertain');
    }
    if (invoked) throw new Stop('yield');
    const started=await jobs.checkpointStart(grant,key,inputDigest);
    if (started.inputDigest!==inputDigest) throw new Stop('checkpoint_input_mismatch');
    if (started.status==='completed') return started.output;
    if (started.status!=='started' || started.created!==true) throw new Stop(started.code || 'model_usage_uncertain');
    invoked=true;
    try {
      const output=await execute();
      await jobs.checkpointComplete(grant,key,output);
      return output;
    } catch (error) {
      const code=['request_limit','admission_failed','deadline','model_timeout','model_provider_failure','model_output_invalid','output_limit'].includes(error?.message) ? error.message : 'checkpoint_failure';
      const uncertain=!['request_limit','admission_failed','deadline'].includes(code);
      try { await jobs.checkpointFail(grant,key,code,{uncertain}); } catch { /* the started checkpoint remains non-retriable */ }
      throw new Stop(code);
    }
  };
  try {
    const result=await assessRetainedRubric({AI,allowance,now,...preparedInput,onProfile,deadlineAt,modelCall,calibrationApproved});
    return result.status==='assessed' ? {...result,status:'completed'} : {...result,code:result.code || 'assessment_unavailable'};
  } catch (error) {
    if (error?.resumableAssessment) return {status:error.code==='yield' ? 'yield' : 'unavailable',code:error.code};
    return {status:'unavailable',code:'checkpoint_failure'};
  }
}
