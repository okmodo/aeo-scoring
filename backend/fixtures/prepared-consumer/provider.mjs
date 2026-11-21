// Frozen synthetic provider, not a live-model quality or billing claim.
export const preparedHtml='<html><head><title>Solar kettle</title></head><body><main><h1>Solar kettle</h1><p>Six cups</p><img src="kettle.jpg" alt="Solar kettle"></main></body></html>';
export const originalHtml='<script>ORIGINAL_ONLY_SENTINEL</script>'+preparedHtml;
export const direct=['S1.delivery','S1.readability','S1.supporting-access','S1.scope','S1.configuration','S2.entity','S2.offer','S2.identifiers','S2.variants','S3.identity','S3.price','S3.availability','S3.optional-claims','S4.title','S4.organization','S4.image-alternatives','S7.identity','S7.links','S8.context','S8.guidance','C1.identity','C1.explanation','C1.configuration','C3.price','C3.availability','C3.shipping','C3.returns','C5.consistency','C5.claim-support'];
const groups=['C2.essential','C2.supporting','C4.intended-use','C4.compatibility','C4.limitations','C4.selection'];
const slots=groups.map((group,i)=>({id:`slot-${i}`,group,label:`Need ${i}`,relevance:'Relevant for selection',full:'A complete value',partial:'A partial value',zero:'No useful value',missingExpectation:'State the value'}));
export function syntheticProvider(request){
 const system=request.messages[0].content,p=JSON.parse(request.messages[1].content);
 if(JSON.stringify(p).includes('ORIGINAL_ONLY_SENTINEL'))throw Error('Original HTML leaked to model');
 let response;
 if(system.includes('Extract relevant exact quotations'))response={evidence:[{sourceId:p.sources[0].id,quote:'Solar kettle'}],primaryEvidence:[{sourceId:p.sources[0].id,quote:'Solar kettle'}]};
 else if(system.includes('Identify only the primary'))response={status:'classified',category:'Solar kettle',evidence:[{sourceId:'s1',quote:'Solar kettle'}]};
 else if(system.includes('Independently of any individual'))response={slots};
 else if(system.includes('Inspect this entire source'))response={sections:p.sources.map(s=>({sourceId:s.id,claimsComplete:true,comparisonsComplete:true,claims:[],comparisons:[],checks:[...direct,...slots.map(x=>x.id)].map(id=>({id,status:'unknown',evidence:[]}))}))};
 else response={judgments:[...direct,...slots.map(x=>x.id)].map(id=>id==='C1.identity'?{id,status:'measured',fraction:1,reason:'Primary product identity is stated.',evidence:[{sourceId:'s1',quote:'Solar kettle'}]}:{id,status:'not_measured',fraction:null,reason:'Insufficient evidence',evidence:[]}),c5:{claims:[],comparisons:[]}};
 return{response,usage:{prompt_tokens:100,completion_tokens:100}};
}
// One bad finding must not discard the independent, valid identity finding.
export function mixedProvider(request){
 const result=syntheticProvider(request);
 if(Array.isArray(result.response.judgments)) {
  const bad=result.response.judgments.find(x=>x.id==='C1.explanation');
  Object.assign(bad,{status:'measured',fraction:1,reason:'Unsupported explanation.',evidence:[{sourceId:'s1',quote:'A quote absent from the source'}]});
 }
 return result;
}
