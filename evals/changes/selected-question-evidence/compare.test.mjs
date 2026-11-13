import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { releaseCases } from '../../../backend/fixtures/content-facts/release-cases.mjs';
import { scoreAudit } from '../../../backend/scoring.mjs';
import { buildSemanticRequest } from '../../../backend/semantic-assessment.mjs';
import { inspectProductSchema } from '../../../backend/structure-assessment.mjs';
import { buildContentFactsRequest, decodeContentFacts } from '../../../backend/content-facts.mjs';
import { assessContentFacts } from '../../../backend/fact-grading.mjs';
import { compareFrozen } from './compare.mjs';
import oracle from './source-oracle.json' with {type:'json'};
import approved from './approved-alternatives.json' with {type:'json'};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const cases=[];
for (const input of await releaseCases()) {
  const ref=oracle.cases.find(x=>x.id===input.id),report=scoreAudit(input.snapshot,input.extracted),prepared=buildSemanticRequest(input.snapshot,input.extracted,report,{product:inspectProductSchema(input.snapshot,input.extracted).product}),request=buildContentFactsRequest(prepared),payload=JSON.parse(request.messages[1].content);
  const item={id:input.id,snapshot:input.snapshot,extracted:input.extracted,report,request,requestHash:hash(request),expected:{facts:ref.requiredFacts,findings:ref.findings,checks:ref.score??ref.findings}};
  const raw={roles:Object.fromEntries(payload.candidates.map(c=>[c.roleId,[]])),inspections:[],conditionChecks:Object.fromEntries(payload.conditionKeys.map(k=>[k,input.id==='basic-tshirts'?'absent':'unknown']))};
  for(const f of ref.requiredFacts) {const o=payload.observations.find(o=>o.scope===f.scope&&o.text===f.text),c=payload.candidates.find(c=>c.kind===f.kind&&c.key===f.key&&c.ids.includes(o?.id));if(c&&!raw.roles[c.roleId].some(x=>(typeof x==='string'?x:x.id)===o.id)) raw.roles[c.roleId].push(c.kind==='repeated'?{id:o.id}:o.id);}
  cases.push({item,raw,prepared});
}
const manifest=approved.cases.map((entry,i)=>({...entry,requestHash:cases[i].item.requestHash}));
function resultFor(entry) {
  const {item,raw,prepared}=entry,facts=decodeContentFacts(prepared,item.request,raw,{requireConditionChecks:true,requireRoleSlots:true});
  return {assessmentResult:{status:'assessed',facts},grade:assessContentFacts(item.snapshot,item.extracted,facts),score:scoreAudit(item.snapshot,item.extracted,{validatedFacts:facts}),modelCalls:[{invoked:true,input:item.request,inputHash:item.requestHash,output:{response:JSON.stringify(raw)}}]};
}
for(const entry of cases) test(`${entry.item.id} matches approved oracle and required source roles`,()=>{
  const {item}=entry,result=resultFor(entry);
  assert.equal(compareFrozen(item.id,result,item,manifest),true);
  const forged=structuredClone(result);forged.assessmentResult.facts.facts=[];assert.equal(compareFrozen(item.id,forged,item,manifest),false);
  const wrong=structuredClone(result),key=Object.keys(oracle.cases.find(c=>c.id===item.id).findings)[0];wrong.grade.findings[key]={status:'not_applicable'};assert.equal(compareFrozen(item.id,wrong,item,manifest),false);
  const source=structuredClone(item);source.snapshot.url+='changed';assert.equal(compareFrozen(item.id,result,source,manifest),false);
});
for(const entry of approved.cases) for(const alt of entry.alternatives) test(`${entry.caseId} ${alt.check} accepts only independently bound absence`,()=>{
  const base=cases.find(x=>x.item.id===entry.caseId),copy={...base,raw:structuredClone(base.raw)};
  copy.raw.conditionChecks[alt.conditionKey]='absent';const result=resultFor(copy);
  assert.equal(compareFrozen(entry.caseId,result,copy.item,manifest),true);
  const mutations=[
    r=>{r.modelCalls[0].inputHash='0'.repeat(64);},
    r=>{r.modelCalls[0].input.max_tokens++;},
    r=>{r.modelCalls[0].invoked=false;},
    r=>{const raw=JSON.parse(r.modelCalls[0].output.response);raw.conditionChecks[alt.conditionKey]='unknown';r.modelCalls[0].output.response=JSON.stringify(raw);},
    r=>{const raw=JSON.parse(r.modelCalls[0].output.response);raw.conditionChecks.extra='absent';r.modelCalls[0].output.response=JSON.stringify(raw);},
    r=>{r.assessmentResult.facts.coverage.productComplete=false;},
    r=>{r.assessmentResult.facts.coverage.truncated=true;},
    r=>{r.assessmentResult.facts.coverage.truncatedScopes.push('product');},
    r=>{r.assessmentResult.facts.coverage.uninterpretedScopes.push('product');},
    r=>{r.assessmentResult.facts.coverage.unsafeInstructions=true;},
    r=>{r.assessmentResult.facts.observations[0].text+='changed';},
    r=>{r.grade.findings[alt.check].justification='wrong';},
    r=>{const raw=JSON.parse(r.modelCalls[0].output.response);const slot=Object.keys(raw.roles).find(k=>raw.roles[k].length);raw.roles[slot]=[];r.modelCalls[0].output.response=JSON.stringify(raw);},
  ];
  for(const mutate of mutations) {const value=structuredClone(result);mutate(value);assert.equal(compareFrozen(entry.caseId,value,copy.item,manifest),false);}
  const badManifest=structuredClone(manifest);badManifest.find(e=>e.caseId===entry.caseId).alternatives[0].rule='wrong';assert.equal(compareFrozen(entry.caseId,result,copy.item,badManifest),false);
  const altered=structuredClone(result);altered.assessmentResult.facts.inspections.find(i=>i.kind===alt.inspectionKind&&i.key===alt.inspectionKey&&i.scope==='product').status='unknown';assert.equal(compareFrozen(entry.caseId,altered,copy.item,manifest),false);
  const invalid=structuredClone(result);invalid.grade.findings[alt.check].rule='wrong';assert.equal(compareFrozen(entry.caseId,invalid,copy.item,manifest),false);
});
test('PFD claim support must be measured 0.5; unknown and NA are not alternatives',()=>{
  const entry=cases.find(x=>x.item.id==='personal-flotation-devices'),result=resultFor(entry);
  for(const status of ['not_measured','not_applicable']) {const changed=structuredClone(result);changed.grade.findings['C5.claim-support']={status};assert.equal(compareFrozen(entry.item.id,changed,entry.item,manifest),false);}
});
