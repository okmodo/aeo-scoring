import fs from 'node:fs';
import crypto from 'node:crypto';
import {releaseCases} from '../../../backend/fixtures/content-facts/release-cases.mjs';
import {scoreAudit} from '../../../backend/scoring.mjs';
import {buildSemanticRequest} from '../../../backend/semantic-assessment.mjs';
import {inspectProductSchema} from '../../../backend/structure-assessment.mjs';
import {buildContentFactsRequest} from '../../../backend/content-facts.mjs';
import {contentFactsReservation} from '../../../backend/content-facts-runner.mjs';

const oracleBytes=fs.readFileSync(new URL('./source-oracle.json',import.meta.url));
if (crypto.createHash('sha256').update(oracleBytes).digest('hex') !== '8de968a14ccd27637956de95a420e85dfa646f0c42a03ab88c7cd7a727a430d9') throw new Error('Oracle hash mismatch');
const alternativePath=new URL('./approved-alternatives.json',import.meta.url), approvalPath=new URL('./alternatives-approval.md',import.meta.url);
const alternativeHash=crypto.createHash('sha256').update(fs.readFileSync(alternativePath)).digest('hex');
if (!fs.existsSync(approvalPath) || !fs.readFileSync(approvalPath,'utf8').includes(alternativeHash)) throw new Error('Exact conditional alternatives not yet approved; freeze blocked');
const oracle=JSON.parse(oracleBytes);

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
  const reference=oracle.cases.find(entry=>entry.id===item.id);
  const sourceHash=crypto.createHash('sha256').update(JSON.stringify({snapshot:item.snapshot,extracted:item.extracted})).digest('hex');
  if (!reference || reference.sourceHash !== sourceHash || Object.keys(reference.findings).length !== 15 || !Array.isArray(reference.requiredFacts)) throw new Error('Oracle source mismatch');
  const expected={facts:reference.requiredFacts,findings:reference.findings,checks:reference.score ?? reference.findings};
  cases.push({id:item.id,...value,expected});
}
fs.writeFileSync(new URL('./synthetic-cases.json',import.meta.url),JSON.stringify(cases,null,2)+'\n');
const review=JSON.parse(fs.readFileSync(new URL('./approved-alternatives.json',import.meta.url)));
if (review.cases.length !== cases.length) throw new Error('Invalid reviewed alternatives');
const manifest=review.cases.map((entry,index)=>{
  const item=cases[index], sourceHash=crypto.createHash('sha256').update(JSON.stringify({snapshot:item.snapshot,extracted:item.extracted})).digest('hex');
  if (entry.caseId !== item.id || entry.sourceHash !== sourceHash) throw new Error('Reviewed source mismatch');
  return {...entry,requestHash:item.requestHash};
});
fs.writeFileSync(new URL('./manifest.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n');
const old=JSON.parse(fs.readFileSync(process.argv[2]||'/private/tmp/aeo-ai-r6-runtime.json'));
const snapshot=old.proof.validation.snapshot;
const real=prepare(snapshot,snapshot.extracted);
fs.writeFileSync('/private/tmp/aeo-ai-r13-real-case-final.json',JSON.stringify(real),{mode:0o600});
const summary={synthetic:cases.map(c=>({id:c.id,requestHash:c.requestHash,reservationNeurons:c.reservationNeurons,bytes:Buffer.byteLength(JSON.stringify(c.request))})),real:{privatePath:'/private/tmp/aeo-ai-r13-real-case-final.json',requestHash:real.requestHash,reservationNeurons:real.reservationNeurons,bytes:Buffer.byteLength(JSON.stringify(real.request)),candidates:JSON.parse(real.request.messages[1].content).candidates}};
fs.writeFileSync(new URL('./precall.json',import.meta.url),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary));
