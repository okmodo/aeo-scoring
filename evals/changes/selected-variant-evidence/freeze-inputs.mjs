import fs from 'node:fs';
import crypto from 'node:crypto';
import {releaseCases} from '../../../backend/fixtures/content-facts/release-cases.mjs';
import {scoreAudit} from '../../../backend/scoring.mjs';
import {buildSemanticRequest} from '../../../backend/semantic-assessment.mjs';
import {inspectProductSchema} from '../../../backend/structure-assessment.mjs';
import {buildContentFactsRequest,decodeContentFacts} from '../../../backend/content-facts.mjs';
import {assessContentFacts} from '../../../backend/fact-grading.mjs';
import {referenceShirtResponse} from '../../../backend/fixtures/content-facts/reference-shirt.mjs';
import {contentFactsReservation} from '../../../backend/content-facts-runner.mjs';

function prepare(snapshot, extracted) {
  const report=scoreAudit(snapshot,extracted);
  const prepared=buildSemanticRequest(snapshot,extracted,report,{product:inspectProductSchema(snapshot,extracted).product});
  const request=buildContentFactsRequest(prepared);
  const requestHash=crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
  return {snapshot,extracted,report,prepared,request,requestHash,reservationNeurons:contentFactsReservation(request)};
}
const cases=[];
for(const item of await releaseCases()) {
  const {prepared,...value}=prepare(item.snapshot,item.extracted);
  const expected={...item.expected};
  if (item.id === 'basic-tshirts') {
    const reference=referenceShirtResponse(value.request), observations=JSON.parse(value.request.messages[1].content).observations;
    expected.facts=reference.facts.map(f=>{ const observation=observations.find(o=>o.id===f.quoteIds[0]); return {kind:f.kind,key:f.key,scope:observation.scope,text:observation.text}; });
    const facts=decodeContentFacts(prepared,value.request,reference);
    const findings=assessContentFacts(item.snapshot,item.extracted,facts).findings;
    expected.findings=Object.fromEntries(Object.entries(findings).map(([key, finding])=>[key,finding.status==='measured' ? finding.fraction : finding.status]));
    if (Object.keys(expected.findings).length !== 15) throw new Error('Invalid shirt findings');
  }
  cases.push({id:item.id,...value,expected});
}
fs.writeFileSync(new URL('./synthetic-cases.json',import.meta.url),JSON.stringify(cases,null,2)+'\n');
const review=JSON.parse(fs.readFileSync(new URL('../source-aware-live-references/approved-alternatives.json',import.meta.url)));
if (review.cases.length !== cases.length) throw new Error('Invalid reviewed alternatives');
const manifest=review.cases.map((entry,index)=>{
  const item=cases[index], sourceHash=crypto.createHash('sha256').update(JSON.stringify({snapshot:item.snapshot,extracted:item.extracted})).digest('hex');
  if (entry.caseId !== item.id || entry.sourceHash !== sourceHash) throw new Error('Reviewed source mismatch');
  return {...entry,requestHash:item.requestHash};
});
fs.writeFileSync(new URL('../source-aware-live-references/manifest.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n');
const old=JSON.parse(fs.readFileSync(process.argv[2]||'/private/tmp/aeo-ai-r6-runtime.json'));
const snapshot=old.proof.validation.snapshot;
const real=prepare(snapshot,snapshot.extracted);
fs.writeFileSync('/private/tmp/aeo-ai-r11-real-case-final.json',JSON.stringify(real),{mode:0o600});
const summary={synthetic:cases.map(c=>({id:c.id,requestHash:c.requestHash,reservationNeurons:c.reservationNeurons,bytes:Buffer.byteLength(JSON.stringify(c.request))})),real:{privatePath:'/private/tmp/aeo-ai-r11-real-case-final.json',requestHash:real.requestHash,reservationNeurons:real.reservationNeurons,bytes:Buffer.byteLength(JSON.stringify(real.request)),candidates:JSON.parse(real.request.messages[1].content).candidates}};
fs.writeFileSync(new URL('./precall.json',import.meta.url),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary));
