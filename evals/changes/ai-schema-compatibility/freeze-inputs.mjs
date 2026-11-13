import fs from 'node:fs';
import crypto from 'node:crypto';
import {releaseCases} from '../../../backend/fixtures/content-facts/release-cases.mjs';
import {scoreAudit} from '../../../backend/scoring.mjs';
import {buildSemanticRequest} from '../../../backend/semantic-assessment.mjs';
import {inspectProductSchema} from '../../../backend/structure-assessment.mjs';
import {buildContentFactsRequest} from '../../../backend/content-facts.mjs';
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
  cases.push({id:item.id,...value,expected:item.expected});
}
fs.writeFileSync(new URL('./synthetic-cases.json',import.meta.url),JSON.stringify(cases,null,2)+'\n');
const old=JSON.parse(fs.readFileSync(process.argv[2]||'/private/tmp/aeo-ai-r6-runtime.json'));
const snapshot=old.proof.validation.snapshot;
const real=prepare(snapshot,snapshot.extracted);
fs.writeFileSync('/private/tmp/aeo-ai-r10-real-case-final.json',JSON.stringify(real),{mode:0o600});
const summary={synthetic:cases.map(c=>({id:c.id,requestHash:c.requestHash,reservationNeurons:c.reservationNeurons,bytes:Buffer.byteLength(JSON.stringify(c.request))})),real:{privatePath:'/private/tmp/aeo-ai-r10-real-case-final.json',requestHash:real.requestHash,reservationNeurons:real.reservationNeurons,bytes:Buffer.byteLength(JSON.stringify(real.request)),candidates:JSON.parse(real.request.messages[1].content).candidates}};
fs.writeFileSync(new URL('./precall.json',import.meta.url),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary));
