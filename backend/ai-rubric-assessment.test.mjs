import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareAssessmentSources} from './assessment-sources.mjs';
import {assessRetainedRubric,validateRubricProfile,validateRubricAssessment,isValidatedRubricAssessment,restoreRubricAssessment,rubricProfileDigest} from './ai-rubric-assessment.mjs';

const groups=['C2.essential','C2.supporting','C4.intended-use','C4.compatibility','C4.limitations','C4.selection'];
const direct=['S1.delivery','S1.readability','S1.supporting-access','S1.scope','S1.configuration','S2.entity','S2.offer','S2.identifiers','S2.variants','S3.identity','S3.price','S3.availability','S3.optional-claims','S4.title','S4.organization','S4.image-alternatives','S7.identity','S7.links','S8.context','S8.guidance','C1.identity','C1.explanation','C1.configuration','C3.price','C3.availability','C3.shipping','C3.returns','C5.consistency','C5.claim-support'];
const fixture=async()=>{
 const snapshot={url:'https://example.com/item',rawHtml:'<h1>Solar kettle</h1><p>Six cups</p>'}, extracted={productHtml:{blocks:[{text:'Solar kettle',location:'heading'}]}};
 const bundle=await prepareAssessmentSources(snapshot,extracted), source=bundle.sources[0];
 const profile={category:'Solar kettle',evidence:[{sourceId:source.id,quote:'Solar kettle'}],slots:groups.map((group,i)=>({id:`slot-${i}`,group,label:`Need ${i}`,relevance:'Relevant for selection',full:'A complete value',partial:'A partial value',zero:'No useful value',missingExpectation:'State the value'}))};
 const judgments={judgments:[...direct,...profile.slots.map(s=>s.id)].map(id=>({id,status:'not_measured',fraction:null,reason:'Insufficient evidence',evidence:[]}))};
 return {snapshot,extracted,bundle,source,profile,judgments};
};
test('dynamic profile validates and assessment remains bound to its retained inputs',async()=>{
 const f=await fixture(); const p=validateRubricProfile(f.bundle,f.profile); assert.equal(p.slots.length,6);
 const assessment=validateRubricAssessment(f.bundle,p,f.judgments,f);
 assert.equal(isValidatedRubricAssessment(assessment,f.snapshot,f.extracted),true);
 assert.equal(isValidatedRubricAssessment(assessment,{...f.snapshot},f.extracted),false);
 assert.equal(assessment.findings['C2.essential'].status,'not_measured');
 const inspections=f.bundle.sources.map(source=>({sourceId:source.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[],checks:[...direct,...f.profile.slots.map(s=>s.id)].map(id=>({id,status:'unknown',evidence:[]}))}));
 const artifact={version:'1',sourceDigest:f.bundle.sourceDigest,profileDigest:await rubricProfileDigest(f.profile),profile:f.profile,inspections,judgments:f.judgments};
 assert.equal(isValidatedRubricAssessment(await restoreRubricAssessment(f.snapshot,f.extracted,artifact),f.snapshot,f.extracted),true);
 await assert.rejects(()=>restoreRubricAssessment({...f.snapshot,rawHtml:'changed'},f.extracted,artifact));
 f.snapshot.rawHtml='changed'; assert.equal(isValidatedRubricAssessment(assessment,f.snapshot,f.extracted),false);
});
test('forged evidence, false exclusions and absence without complete inspection remain unknown',async()=>{
 const f=await fixture();
 for (const [id,change] of [
  ['C1.identity',{status:'measured',fraction:1,reason:'present',evidence:[{sourceId:f.source.id,quote:'invented'}]}],
  ['C5.claim-support',{status:'not_applicable',fraction:null,reason:'none',rule:'no_material_claims',evidence:[{sourceId:f.source.id,quote:'Solar kettle'}]}],
  ['C1.explanation',{status:'measured',fraction:0,reason:'missing',evidence:[{sourceId:f.source.id,quote:'Solar kettle'}]}],
 ]) Object.assign(f.judgments.judgments.find(x=>x.id===id),change);
 const a=validateRubricAssessment(f.bundle,f.profile,f.judgments,f);
 for (const id of ['C1.identity','C5.claim-support','C1.explanation']) assert.equal(a.findings[id].status,'not_measured');
 assert.throws(()=>validateRubricProfile(f.bundle,{...f.profile,evidence:[{sourceId:f.source.id,quote:'fiction'}]}));
});
test('calibration gate makes no provider or budget calls',async()=>{
 const f=await fixture(); let calls=0;
 const result=await assessRetainedRubric({AI:{run(){calls++;}},allowance:{reserve(){calls++;}},...f});
 assert.equal(result.status,'unavailable'); assert.equal(calls,0);
});
test('failed section call reserves capacity and cannot claim complete assessment',async()=>{
 const f=await fixture(); let reservations=0,settlements=0;
 const result=await assessRetainedRubric({AI:{run(){throw Error('offline');}},allowance:{reserve(){reservations++;return {accepted:true,duplicate:false};},settle(){settlements++;}},calibrationApproved:true,...f});
 assert.equal(result.status,'unavailable'); assert.equal(reservations,1); assert.equal(settlements,0);
});
test('absence requires an explicit complete per-section inspection',async()=>{
 const f=await fixture(), id='C1.explanation';
 Object.assign(f.judgments.judgments.find(x=>x.id===id),{status:'measured',fraction:0,basis:'absence',reason:'No explanation found',evidence:[{sourceId:f.source.id,quote:'Solar kettle'}]});
 const inspections=f.bundle.sources.map(source=>({sourceId:source.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[],checks:[...direct,...f.profile.slots.map(s=>s.id)].map(key=>({id:key,status:'absent',evidence:[]}))}));
 assert.equal(validateRubricAssessment(f.bundle,f.profile,f.judgments,{...f,inspections}).findings[id].fraction,0);
 inspections[0].checks.find(x=>x.id===id).status='unknown';
 assert.equal(validateRubricAssessment(f.bundle,f.profile,f.judgments,{...f,inspections}).findings[id].status,'not_measured');
});
test('mock assessment inspects every section, freezes category expectations and replays',async()=>{
 const f=await fixture(); const requests=[], reserves=[], settles=[];
 const AI={run(_model,input){
  requests.push(input); const system=input.messages[0].content, payload=JSON.parse(input.messages[1].content); let response;
  if (system.includes('Extract relevant exact quotations')) response={evidence:[]};
  else if (system.includes('Identify only the primary')) response={status:'classified',category:f.profile.category,evidence:f.profile.evidence};
  else if (system.includes('Independently of any individual')) response={slots:f.profile.slots};
  else if (system.includes('Inspect this entire source')) response={sourceId:payload.source.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[],checks:[...direct,...f.profile.slots.map(s=>s.id)].map(id=>({id,status:'unknown',evidence:[]}))};
  else response=f.judgments;
  return {response,usage:{prompt_tokens:100,completion_tokens:100},choices:[{finish_reason:'stop'}]};
 }};
 const result=await assessRetainedRubric({AI,allowance:{reserve(v){reserves.push(v);return {accepted:true,duplicate:false};},settle(v){settles.push(v);}},calibrationApproved:true,...f});
 assert.equal(result.status,'assessed'); assert.equal(reserves.length,requests.length); assert.equal(settles.length,requests.length);
 assert.equal(requests.filter(x=>x.messages[0].content.includes('Inspect this entire source')).length,f.bundle.sources.length);
 const expectation=requests.find(x=>x.messages[0].content.includes('Independently of any individual')); assert.deepEqual(JSON.parse(expectation.messages[1].content),{category:'Solar kettle'});
 assert.equal(isValidatedRubricAssessment(await restoreRubricAssessment(f.snapshot,f.extracted,result.replayArtifact),f.snapshot,f.extracted),true);
});
test('category slot averages preserve partial, proven absence, and unknown distinctly',async()=>{
 const f=await fixture(); const id='slot-0', item=f.judgments.judgments.find(x=>x.id===id);
 const inspections=f.bundle.sources.map(source=>({sourceId:source.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[],checks:[...direct,...f.profile.slots.map(s=>s.id)].map(key=>({id:key,status:'absent',evidence:[]}))}));
 const options={...f,inspections};
 Object.assign(item,{status:'measured',fraction:0.5,reason:'Some details',evidence:[{sourceId:f.source.id,quote:'Solar kettle'}]});
 assert.equal(validateRubricAssessment(f.bundle,f.profile,f.judgments,options).findings['C2.essential'].fraction,0.5);
 Object.assign(item,{fraction:0,basis:'absence',reason:'Not found'});
 assert.equal(validateRubricAssessment(f.bundle,f.profile,f.judgments,options).findings['C2.essential'].fraction,0);
 inspections.find(x=>x.sourceId===f.source.id).checks.find(x=>x.id===id).status='unknown';
 assert.equal(validateRubricAssessment(f.bundle,f.profile,f.judgments,options).findings['C2.essential'].status,'not_measured');
});
test('replay rejects fabricated section coverage and fabricated present evidence',async()=>{
 const f=await fixture();
 const inspections=f.bundle.sources.map(source=>({sourceId:source.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[],checks:[...direct,...f.profile.slots.map(s=>s.id)].map(id=>({id,status:'absent',evidence:[]}))}));
 const artifact={version:'1',sourceDigest:f.bundle.sourceDigest,profileDigest:await rubricProfileDigest(f.profile),profile:f.profile,inspections,judgments:f.judgments};
 artifact.inspections[0].checks.pop();
 await assert.rejects(()=>restoreRubricAssessment(f.snapshot,f.extracted,artifact));
 artifact.inspections[0].checks.push({id:f.profile.slots.at(-1).id,status:'present',evidence:[{sourceId:f.source.id,quote:'forged'}]});
 await assert.rejects(()=>restoreRubricAssessment(f.snapshot,f.extracted,artifact));
});
test('specific prose can earn a full category attribute, and conflicting statements can earn zero',async()=>{
 const f=await fixture(); f.snapshot.rawHtml='<h1>Solar kettle</h1><p>Hand wash only.</p><p>Holds six cups.</p><p>Holds eight cups.</p>';
 f.bundle=await prepareAssessmentSources(f.snapshot,f.extracted); f.source=f.bundle.sources[0];
 Object.assign(f.profile.slots[0],{label:'Care instructions',full:'A specific care method is stated',partial:'Some incomplete care information',zero:'No useful care instructions'});
 const slot=f.judgments.judgments.find(x=>x.id==='slot-0');
 Object.assign(slot,{status:'measured',fraction:1,reason:'Specific care instruction',evidence:[{sourceId:f.source.id,quote:'Hand wash only.'}]});
 const consistency=f.judgments.judgments.find(x=>x.id==='C5.consistency');
 Object.assign(consistency,{status:'measured',fraction:0,basis:'contradiction',reason:'Capacity conflicts',comparisonContext:'The same kettle capacity',evidence:[{sourceId:f.source.id,quote:'Holds six cups.'},{sourceId:f.source.id,quote:'Holds eight cups.'}]});
 const inspections=f.bundle.sources.map(source=>({sourceId:source.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:source.id===f.source.id?[{field:'capacity',context:'same kettle',quote:'Holds six cups.'},{field:'capacity',context:'same kettle',quote:'Holds eight cups.'}]:[],checks:[...direct,...f.profile.slots.map(s=>s.id)].map(id=>({id,status:'unknown',evidence:[]}))}));
 f.judgments.c5={claims:[],comparisons:[{candidateIds:[`${f.source.id}-comparison-0`,`${f.source.id}-comparison-1`],status:'measured',fraction:0,reason:'Capacity conflicts',context:'Same kettle'}]};
 const result=validateRubricAssessment(f.bundle,f.profile,f.judgments,{...f,inspections,supportInspections:[]});
 assert.equal(result.findings['C2.essential'].fraction,1); assert.equal(result.findings['C5.consistency'].fraction,0);
 f.judgments.c5.comparisons[0].candidateIds.pop(); assert.equal(validateRubricAssessment(f.bundle,f.profile,f.judgments,{...f,inspections,supportInspections:[]}).findings['C5.consistency'].status,'not_measured');
});
test('ambiguous primary product cannot be replaced by a recommendation',async()=>{
 const f=await fixture(); f.snapshot.rawHtml='<div>Products you may also like: Solar kettle</div>';
 let expectationCalls=0;
 const AI={run(_model,input){
  const system=input.messages[0].content;
  if (system.includes('Extract relevant exact quotations')) return {response:{evidence:[],primaryEvidence:[]}};
  if (system.includes('Identify only the primary')) return {response:{status:'ambiguous',category:null,evidence:[]}};
  expectationCalls++; throw Error('must not generate profile');
 }};
 const result=await assessRetainedRubric({AI,allowance:{reserve(){return {accepted:true,duplicate:false};}},calibrationApproved:true,...f});
 assert.equal(result.status,'unavailable'); assert.equal(expectationCalls,0);
});
test('all material claims receive credit individually, with support absence proven for zero',async()=>{
 const f=await fixture(); f.snapshot.rawHtml='<h1>Solar kettle</h1><p>Boils in 5 minutes.</p><p>Lab test measured 5 minutes.</p><p>Removes 99% of toxins.</p>';
 f.bundle=await prepareAssessmentSources(f.snapshot,f.extracted); f.source=f.bundle.sources[0];
 const inspections=f.bundle.sources.map(source=>({sourceId:source.id,claimsComplete:true,comparisonsComplete:true,claims:source.id===f.source.id?[{quote:'Boils in 5 minutes.'},{quote:'Removes 99% of toxins.'}]:[],comparisons:[],checks:[...direct,...f.profile.slots.map(s=>s.id)].map(id=>({id,status:'unknown',evidence:[]}))}));
 const one=`${f.source.id}-claim-0`, two=`${f.source.id}-claim-1`;
 const supportInspections=f.bundle.sources.map(source=>({sourceId:source.id,claims:[{id:one,references:[],status:source.id===f.source.id?'present':'absent',evidence:source.id===f.source.id?[{sourceId:source.id,quote:'Lab test measured 5 minutes.'}]:[]},{id:two,references:[],status:'absent',evidence:[]}]}));
 f.judgments.c5={claims:[{id:one,status:'measured',fraction:1,reason:'Lab test stated',evidence:[{sourceId:f.source.id,quote:'Boils in 5 minutes.'},{sourceId:f.source.id,quote:'Lab test measured 5 minutes.'}]},{id:two,status:'measured',fraction:0,reason:'No support found',evidence:[{sourceId:f.source.id,quote:'Removes 99% of toxins.'}]}],comparisons:[]};
 const options={...f,inspections,supportInspections};
 assert.equal(validateRubricAssessment(f.bundle,f.profile,f.judgments,options).findings['C5.claim-support'].fraction,0.5);
 supportInspections[0].claims[1].status='unknown'; assert.equal(validateRubricAssessment(f.bundle,f.profile,f.judgments,options).findings['C5.claim-support'].status,'not_measured');
 supportInspections[0].claims[1].status='absent'; f.judgments.c5.claims.pop(); assert.equal(validateRubricAssessment(f.bundle,f.profile,f.judgments,options).findings['C5.claim-support'].status,'not_measured');
});
test('unread claim substantiation reference withholds unsupported-claim zero',async()=>{
 const f=await fixture(); f.snapshot.rawHtml='<h1>Solar kettle</h1><p>Removes 99% of toxins.</p><a href="/test-report">test report</a>';
 f.bundle=await prepareAssessmentSources(f.snapshot,f.extracted); f.source=f.bundle.sources[0];
 const inspections=f.bundle.sources.map(s=>({sourceId:s.id,claimsComplete:true,comparisonsComplete:true,claims:s.id===f.source.id?[{quote:'Removes 99% of toxins.'}]:[],comparisons:[],checks:[...direct,...f.profile.slots.map(x=>x.id)].map(id=>({id,status:'unknown',evidence:[]}))}));
 const id=`${f.source.id}-claim-0`, supportInspections=f.bundle.sources.map(s=>({sourceId:s.id,claims:[{id,status:'absent',evidence:[],references:s.id===f.source.id?[{quote:'test report',target:'/test-report'}]:[]}]}));
 f.judgments.c5={claims:[{id,status:'measured',fraction:0,reason:'No captured support',evidence:[{sourceId:f.source.id,quote:'Removes 99% of toxins.'}]}],comparisons:[]};
 assert.equal(validateRubricAssessment(f.bundle,f.profile,f.judgments,{...f,inspections,supportInspections}).findings['C5.claim-support'].status,'not_measured');
});
test('conditional C4 excludes only a proven absent condition, not an unanswered question',async()=>{
 const f=await fixture(), slot=f.profile.slots.find(s=>s.group==='C4.compatibility');
 Object.assign(slot,{applicability:'conditional',condition:'Product requires external power',conditionWhy:'Electrical compatibility matters only if power is required'});
 f.profile.conditionReview=[{id:slot.id,valid:true,reason:'Observable product circumstance'}];
 const inspections=f.bundle.sources.map(s=>({sourceId:s.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[],conditions:[{id:slot.id,status:'absent',evidence:[]}],checks:[...direct,...f.profile.slots.map(x=>x.id)].map(id=>({id,status:'absent',evidence:[]}))}));
 const item=f.judgments.judgments.find(x=>x.id===slot.id); Object.assign(item,{status:'not_applicable',fraction:null,rule:'category_conditions_absent',reason:'No external power applies',evidence:[{sourceId:f.source.id,quote:'Solar kettle'}]});
 const check=()=>validateRubricAssessment(f.bundle,f.profile,f.judgments,{...f,inspections,supportInspections:[]}).findings['C4.compatibility'];
 let result=check(); assert.equal(result.status,'not_applicable'); assert.equal(result.rule,'category_conditions_absent'); assert.equal(result.conditions[0].condition,slot.condition);
 inspections[0].conditions[0].status='unknown'; assert.equal(check().status,'not_measured');
 inspections[0].conditions[0].status='absent'; slot.applicability='always'; slot.condition=null; slot.conditionWhy=null; f.profile.conditionReview=[]; assert.equal(check().status,'not_measured');
});
test('conditional C4 excludes absent slots and retains applicable measured slots',async()=>{
 const f=await fixture(), slot=f.profile.slots.find(s=>s.group==='C4.selection');
 Object.assign(slot,{applicability:'conditional',condition:'Multiple sizes are offered',conditionWhy:'Size choice applies only to multiple sizes'});
 f.profile.slots.push({...slot,id:'another-question',applicability:'always',condition:null,conditionWhy:null,label:'Use guidance'});
 f.judgments.judgments.push({id:'another-question',status:'measured',fraction:0.5,reason:'Partial guidance',evidence:[{sourceId:f.source.id,quote:'Solar kettle'}]});
 Object.assign(f.judgments.judgments.find(x=>x.id===slot.id),{status:'not_applicable',fraction:null,rule:'category_conditions_absent',reason:'One size only',evidence:[{sourceId:f.source.id,quote:'Solar kettle'}]});
 f.profile.conditionReview=[{id:slot.id,valid:true,reason:'Observable product circumstance'}];
 const inspections=f.bundle.sources.map(s=>({sourceId:s.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[],conditions:[{id:slot.id,status:'absent',evidence:[]}],checks:[...direct,...f.profile.slots.map(x=>x.id)].map(id=>({id,status:'absent',evidence:[]}))}));
 const result=validateRubricAssessment(f.bundle,f.profile,f.judgments,{...f,inspections,supportInspections:[]}).findings['C4.selection']; assert.equal(result.status,'measured'); assert.equal(result.fraction,0.5);
});
test('C5 accepts quoted equivalent values and still distinguishes contradictions',async()=>{
 const f=await fixture(); f.snapshot.rawHtml='<h1>Solar kettle</h1><p>Weight: 1 kg</p><p>Weight: 1000 g</p>'; f.bundle=await prepareAssessmentSources(f.snapshot,f.extracted); f.source=f.bundle.sources[0];
 const inspections=f.bundle.sources.map(s=>({sourceId:s.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:s.id===f.source.id?[{field:'weight',context:'same kettle',quote:'Weight: 1 kg'},{field:'weight',context:'same kettle',quote:'Weight: 1000 g'}]:[],checks:[...direct,...f.profile.slots.map(x=>x.id)].map(id=>({id,status:'unknown',evidence:[]}))}));
 const group={candidateIds:[`${f.source.id}-comparison-0`,`${f.source.id}-comparison-1`],status:'measured',fraction:1,reason:'One kilogram equals one thousand grams',context:'same kettle'};
 f.judgments.c5={claims:[],comparisons:[group]}; const check=()=>validateRubricAssessment(f.bundle,f.profile,f.judgments,{...f,inspections,supportInspections:[]}).findings['C5.consistency'];
 assert.equal(check().fraction,1); group.fraction=0; group.reason='Conflicting weights'; assert.equal(check().fraction,0);
 inspections[0].comparisons[1].context='different variant'; assert.equal(check().status,'not_measured');
});
test('generic present attribute can earn zero only after complete inspection',async()=>{
 const f=await fixture(); f.snapshot.rawHtml='<h1>Solar kettle</h1><p>Premium quality.</p>'; f.bundle=await prepareAssessmentSources(f.snapshot,f.extracted); f.source=f.bundle.sources[0]; const id='slot-0';
 const inspections=f.bundle.sources.map(s=>({sourceId:s.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[],checks:[...direct,...f.profile.slots.map(x=>x.id)].map(key=>({id:key,status:key===id&&s.id===f.source.id?'present':'absent',evidence:key===id&&s.id===f.source.id?[{sourceId:s.id,quote:'Premium quality.'}]:[]}))}));
 Object.assign(f.judgments.judgments.find(x=>x.id===id),{status:'measured',fraction:0,basis:'generic',reason:'Generic wording does not specify the attribute',evidence:[{sourceId:f.source.id,quote:'Premium quality.'}]});
 const check=()=>validateRubricAssessment(f.bundle,f.profile,f.judgments,{...f,inspections,supportInspections:[]}).findings['C2.essential'];
 assert.equal(check().fraction,0); inspections[0].checks.find(x=>x.id===id).status='unknown'; assert.equal(check().status,'not_measured');
});
test('confirmed absent policy differs from failed or unread policy',async()=>{
 const f=await fixture(); f.snapshot.policies={shipping:{state:'absent'}}; f.bundle=await prepareAssessmentSources(f.snapshot,f.extracted); f.source=f.bundle.sources[0]; const id='C3.shipping';
 const inspections=f.bundle.sources.map(s=>({sourceId:s.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[],checks:[...direct,...f.profile.slots.map(x=>x.id)].map(key=>({id:key,status:'absent',evidence:[]}))}));
 Object.assign(f.judgments.judgments.find(x=>x.id===id),{status:'measured',fraction:0,basis:'absence',reason:'No shipping details and linked policy is absent',evidence:[{sourceId:f.source.id,quote:'Solar kettle'}]});
 const check=()=>validateRubricAssessment(f.bundle,f.profile,f.judgments,{...f,inspections,supportInspections:[]}).findings[id];
 assert.equal(check().fraction,0); f.snapshot.policies.shipping.state='failed'; assert.equal(check().status,'not_measured');
});
test('conditional profile rejects circular answer-presence conditions',async()=>{
 const f=await fixture(), slot=f.profile.slots.find(s=>s.group==='C4.compatibility');
 Object.assign(slot,{applicability:'conditional',condition:'Compatibility information is provided',conditionWhy:'An answer is present'});
 assert.throws(()=>validateRubricProfile(f.bundle,f.profile));
 slot.condition='Compatible devices are specified'; assert.throws(()=>validateRubricProfile(f.bundle,f.profile));
});
test('independent category-only review must approve each conditional circumstance',async()=>{
 const f=await fixture(),slot=f.profile.slots.find(s=>s.group==='C4.selection');
 Object.assign(slot,{applicability:'conditional',condition:'A size recommendation exists',conditionWhy:'Controls whether selection applies'});
 f.profile.conditionReview=[{id:slot.id,valid:false,reason:'Circular answer presence'}]; assert.throws(()=>validateRubricProfile(f.bundle,f.profile));
 slot.condition='Multiple sizes are offered'; f.profile.conditionReview=[{id:slot.id,valid:true,reason:'Observable product feature'}];
 assert.equal(validateRubricProfile(f.bundle,f.profile).slots.find(x=>x.id===slot.id).applicability,'conditional');
 f.profile.conditionReview=[]; assert.throws(()=>validateRubricProfile(f.bundle,f.profile));
});
test('conditional profile uses separate category-only model review before freezing',async()=>{
 const f=await fixture(), slot=f.profile.slots.find(s=>s.group==='C4.selection'); Object.assign(slot,{applicability:'conditional',condition:'Multiple sizes are offered',conditionWhy:'Choice only applies with alternatives'});
 const calls=[]; let reviewedValid=true;
 const AI={run(_model,input){ calls.push(input); const system=input.messages[0].content,payload=JSON.parse(input.messages[1].content); let response;
  if (system.includes('Extract relevant exact quotations')) response={evidence:[]};
  else if (system.includes('Identify only the primary')) response={status:'classified',category:f.profile.category,evidence:f.profile.evidence};
  else if (system.includes('Independently of any individual')) response={slots:f.profile.slots};
  else if (system.includes('Independently review each proposed')) response={conditions:[{id:slot.id,valid:reviewedValid,reason:'Checked independently'}]};
  else if (system.includes('Inspect this entire source')) response={sourceId:payload.source.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[],conditions:[{id:slot.id,status:'unknown',evidence:[]}],checks:[...direct,...f.profile.slots.map(s=>s.id)].map(id=>({id,status:'unknown',evidence:[]}))};
  else response=f.judgments;
  return {response};
 }};
 const args={AI,allowance:{reserve(){return {accepted:true,duplicate:false};}},calibrationApproved:true,...f};
 let result=await assessRetainedRubric(args); assert.equal(result.status,'assessed');
 const review=calls.find(x=>x.messages[0].content.includes('Independently review each proposed')); const payload=JSON.parse(review.messages[1].content); assert.deepEqual(Object.keys(payload).sort(),['category','slots']); assert.equal(result.profile.conditionReview[0].valid,true);
 reviewedValid=false; result=await assessRetainedRubric(args); assert.equal(result.status,'unavailable');
});
test('category candidates use only product sections while inspections cover every retained section',async()=>{
 const f=await fixture(), candidates=[], inspections=[];
 assert.ok(f.bundle.sources.some(s=>s.scope==='metadata'));
 const AI={run(_model,input){
  const system=input.messages[0].content,payload=JSON.parse(input.messages[1].content); let response;
  if (system.includes('Extract relevant exact quotations')) {
   candidates.push(payload.source.id);
   // This bad metadata quotation would fail strict refs if metadata were requested here.
   response=payload.source.scope==='metadata'?{evidence:[{sourceId:payload.source.id,quote:'not verbatim'}]}:{evidence:[]};
  } else if (system.includes('Identify only the primary')) response={status:'classified',category:f.profile.category,evidence:f.profile.evidence};
  else if (system.includes('Independently of any individual')) response={slots:f.profile.slots};
  else if (system.includes('Inspect this entire source')) {inspections.push(payload.source.id); response={sourceId:payload.source.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[],checks:[...direct,...f.profile.slots.map(s=>s.id)].map(id=>({id,status:'unknown',evidence:[]}))};}
  else response=f.judgments;
  return {response};
 }};
 const args={AI,allowance:{reserve(){return {accepted:true,duplicate:false};}},calibrationApproved:true,...f};
 assert.equal((await assessRetainedRubric(args)).status,'assessed');
 assert.deepEqual(candidates,f.bundle.sources.filter(s=>s.scope==='product').map(s=>s.id));
 assert.deepEqual(inspections,f.bundle.sources.map(s=>s.id));
 let calls=0;
 const badAI={run(_model,input){calls++;const source=JSON.parse(input.messages[1].content).source;return {response:{evidence:[{sourceId:source.id,quote:'not verbatim'}]}};}};
 assert.equal((await assessRetainedRubric({...args,AI:badAI})).status,'unavailable');
 assert.equal(calls,1);
});
