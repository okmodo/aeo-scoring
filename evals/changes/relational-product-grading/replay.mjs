// Offline replay only. Reads a private captured proof; output contains no source text.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { scoreAudit } from '../../../backend/scoring.mjs';
import { buildSemanticRequest } from '../../../backend/semantic-assessment.mjs';
import { inspectProductSchema } from '../../../backend/structure-assessment.mjs';
import { buildContentFactsRequest, decodeContentFacts } from '../../../backend/content-facts.mjs';
import { assessContentFacts } from '../../../backend/fact-grading.mjs';
const expectedInput='41bd86578b9b4c97dd99f55963393a4413f39b4dd358b21203551429f2c8bc9a';
const expectedProof='312a3b2b7954cf867276d199066f4c89bfe0aaf57847da91391124d79420bacc';
const sha=value=>createHash('sha256').update(value).digest('hex');
const hashObject=value=>sha(JSON.stringify(value));
function unwrap(output) {
  let raw=output?.response ?? output?.output_text;
  if (raw == null && Array.isArray(output?.output)) {
    const parts=output.output.filter(x=>x.type==='message' && x.role==='assistant').flatMap(x=>x.content || []).filter(x=>x.type==='output_text').map(x=>x.text);
    if (parts.length !== 1) throw new Error('Ambiguous provider output');
    raw=parts[0];
  }
  return raw ?? output?.choices?.[0]?.message?.content ?? output;
}
const bytes=await readFile(process.argv[2] || '/private/tmp/aeo-ai-r14-real-runtime.json');
if (sha(bytes)!==expectedProof) throw new Error('Captured proof hash mismatch');
const state=JSON.parse(bytes), proof=state.proof, snapshot=proof?.validation?.snapshot, extracted=snapshot?.extracted, old=proof?.assessment?.report, call=proof?.validation?.modelCalls?.[0];
if (!snapshot || !extracted || !old || state.status!==200 || call?.invoked!==true || proof.validation.modelCalls.filter(c=>c.invoked).length!==1) throw new Error('Invalid captured proof');
const baseline=scoreAudit(snapshot,extracted), prepared=buildSemanticRequest(snapshot,extracted,baseline,{product:inspectProductSchema(snapshot,extracted).product}), request=buildContentFactsRequest(prepared);
if (hashObject(request)!==expectedInput || call.inputHash!==expectedInput || hashObject(call.input)!==expectedInput || proof.validation.preflight?.inputHash!==expectedInput) throw new Error('Captured request mismatch');
const facts=decodeContentFacts(prepared,request,unwrap(call.output),{requireConditionChecks:true,requireRoleSlots:true});
const oldSource=execFileSync('git',['show','4f99ef4:backend/fact-grading.mjs'],{encoding:'utf8'});
if (sha(oldSource)!=='e991f2c549ee1337e927e3f7eb5e2c9afa9a3c2b7132b37a12988a29e213a8f0') throw new Error('Baseline grader mismatch');
const oldModule=oldSource.replace("'./selected-configuration.mjs'",JSON.stringify(new URL('../../../backend/selected-configuration.mjs',import.meta.url).href)).replace("'./content-assessment.mjs'",JSON.stringify(new URL('../../../backend/content-assessment.mjs',import.meta.url).href)).replace("'../config/categories.v1.2.json'",JSON.stringify(new URL('../../../config/categories.v1.2.json',import.meta.url).href));
const previous=await import(`data:text/javascript;base64,${Buffer.from(oldModule).toString('base64')}`);
const oldGrading=previous.assessContentFacts(snapshot,extracted,facts), grading=assessContentFacts(snapshot,extracted,facts), after=scoreAudit(snapshot,extracted,{validatedFacts:facts});
const checks=report=>Object.fromEntries(report.criteria.flatMap(c=>c.subchecks).map(c=>[c.id,c]));
const oldChecks=checks(old),newChecks=checks(after);
if (Object.keys(oldChecks).sort().join()!==Object.keys(newChecks).sort().join()) throw new Error('Check set mismatch');
const evidence=(report,check)=>(check.evidenceIds||[]).map(id=>{ const entry=report.evidence.find(e=>e.id===id); if (!entry) throw new Error('Missing report evidence'); const {id: ignoredId, observedAt: ignoredObservedAt, ...content}=entry; return hashObject(content); }).sort();
const view=(report,check)=>({status:check.status,...(check.fraction===undefined?{}:{fraction:check.fraction}),evidenceSha256:evidence(report,check)});
const differences=Object.keys(oldChecks).flatMap(id=>{const before=view(old,oldChecks[id]),next=view(after,newChecks[id]);return JSON.stringify(before)===JSON.stringify(next)?[]:[{id,before,after:next}];});
const attributes = assessment => Object.fromEntries((assessment.findings['C2.supporting'].attributes || []).map(a=>[a.attributeId ?? a.id ?? a.key,{status:a.status,fraction:a.fraction ?? null}]));
const beforeAttributes=attributes(oldGrading),afterAttributes=attributes(grading);
const attributeChanges=Object.keys({...beforeAttributes,...afterAttributes}).flatMap(id=>JSON.stringify(beforeAttributes[id])===JSON.stringify(afterAttributes[id])?[]:[{id,before:beforeAttributes[id],after:afterAttributes[id]}]);
const expectedDiffs={ 'S1.description':[0.5,1], 'C1.explanation':[0.5,1], 'C2.supporting':[null,null], 'C4.compatibility':[0.5,1] };
if (differences.length !== 4 || differences.some(({id,before,after}) => !expectedDiffs[id] || before.fraction !== expectedDiffs[id][0] || after.fraction !== expectedDiffs[id][1] || before.status !== (id==='C2.supporting' ? 'not_measured' : 'measured') || after.status !== before.status)) throw new Error('Unexpected replay finding differences');
if (attributeChanges.length !== 1 || attributeChanges[0].id !== 'features' || attributeChanges[0].before?.status !== 'not_measured' || attributeChanges[0].after?.status !== 'measured' || attributeChanges[0].after?.fraction !== 1) throw new Error('Unexpected supporting attribute differences');
const summary=report=>({status:report.status,score:report.score,measured:report.coverage.measured,notMeasured:report.coverage.notMeasured,notApplicable:report.coverage.notApplicable,total:report.coverage.total});
if ([old,after].some(report => report.status !== 'incomplete' || report.score !== null || report.coverage.measured !== 27 || report.coverage.notMeasured !== 13 || report.coverage.notApplicable !== 0 || report.coverage.total !== 40)) throw new Error('Unexpected report coverage or score');
console.log(JSON.stringify({version:1,proofSha256:expectedProof,requestSha256:expectedInput,modelInvocationsDuringReplay:0,rawOutputModified:false,before:summary(old),after:summary(after),differences,attributeChanges,baselineGraderSha256:sha(oldSource),decodedFactCount:facts.facts.length,oldRuntime:{cpuMs:466,source:'previous R14 measurement; not this offline replay'}},null,2));
