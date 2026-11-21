import { assessRetainedRubric } from './ai-rubric-assessment.mjs';
import { AI_MODEL_CONFIG } from './ai-model-config.mjs';
import { GRANITE_MODEL_CONFIG } from './granite-provider.mjs';
import { prepareAssessmentSources } from './assessment-sources.mjs';

const encoder = new TextEncoder();
const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value))))].map(x => x.toString(16).padStart(2, '0')).join('');
class Stop extends Error {
  constructor(code) { super(code); this.code = code; this.resumableAssessment = true; }
}

async function validatePreparedInput(preparedInput) {
  const {snapshot, extracted} = preparedInput ?? {};
  if (snapshot?.preprocessing?.representation !== 'cleaned_rendered_html' || snapshot?.preprocessing?.version !== 'simplified-html-v1') throw new TypeError('invalid_prepared_input');
  const bundle = await prepareAssessmentSources(snapshot, extracted);
  if (!bundle.coverage.preparedHtml || !bundle.coverage.complete) throw new TypeError('invalid_prepared_input');
}

// A checkpoint is persisted before invoking the canonical admission and model
// call. A started/uncertain step is never automatically charged again.
export async function runPreparedAssessmentStep({grant,jobs,preparedInput,AI,allowance,provider,now=Date.now,onProfile,calibrationApproved}) {
  if (!grant || !jobs) return {status:'unavailable',code:'invalid_prepared_input'};
  try { await validatePreparedInput(preparedInput); } catch { return {status:'unavailable',code:'invalid_prepared_input'}; }
  const granite = provider === 'granite';
  const config = granite ? GRANITE_MODEL_CONFIG : AI_MODEL_CONFIG;
  let index=0, invoked=false;
  const modelCall=async (args, execute) => {
    index++;
    const key=String(index).padStart(4,'0'), inputDigest=await digest({model:config.model,config,input:args.input,...(granite ? {stage:args.stage} : {})});
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
      const code=['request_limit','admission_failed','model_timeout','model_provider_failure','model_output_invalid','output_limit'].includes(error?.message) ? error.message : 'checkpoint_failure';
      const uncertain=!['request_limit','admission_failed'].includes(code);
      try { await jobs.checkpointFail(grant,key,code,{uncertain}); } catch { /* the started checkpoint remains non-retriable */ }
      throw new Stop(code);
    }
  };
  try {
    const result=await assessRetainedRubric({AI,allowance,now,...preparedInput,onProfile,modelCall,provider,calibrationApproved});
    return result.status==='assessed' ? {...result,status:'completed'} : {...result,code:result.code || 'assessment_unavailable'};
  } catch (error) {
    if (error?.resumableAssessment) return {status:error.code==='yield' ? 'yield' : 'unavailable',code:error.code};
    return {status:'unavailable',code:'checkpoint_failure'};
  }
}
