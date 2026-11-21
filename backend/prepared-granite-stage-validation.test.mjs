import test from 'node:test';
import assert from 'node:assert/strict';
import {validateGraniteStage} from './granite-stage-validation.mjs';

const ref={sourceId:'s1',quote:'Product'};
const check={id:'x',status:'present',evidence:[ref]};
const inspection={sourceId:'s1',checks:[check],claimsComplete:true,comparisonsComplete:false,claims:[{quote:'claim'}],comparisons:[{field:'weight',context:'product',quote:'1 kg'}]};
const support={sourceId:'s1',claims:[{...check,references:[{quote:'study',target:null}]}]};
const cases={
  extraction:{evidence:[ref]},
  category:{status:'classified',category:'shoes',evidence:[ref]},
  profile:{slots:[{id:'x',group:'C2.essential',label:'x',relevance:'x',full:'x',partial:'x',zero:'x',missingExpectation:'x'}]},
  conditions:{conditions:[{id:'x',valid:false,reason:'x'}]},
  inspection:{sections:[inspection]},
  support:{sections:[support]},
  judgment:{judgments:[{id:'x',status:'not_measured',fraction:null,reason:'unknown',evidence:[]}],c5:{claims:[],comparisons:[]}}
};
test('accepts every stage and preserves output identity',()=>{
  for (const [stage,value] of Object.entries(cases)) assert.equal(validateGraniteStage(stage,value),value);
  assert.equal(validateGraniteStage('extraction',{evidence:[{sourceId:'s',fieldPath:['name',0],value:'x'}]}).evidence.length,1);
});
test('rejects malformed category evidence and nested evidence',()=>{
  for (const [stage,value] of [
    ['category',{...cases.category,evidence:'Product'}],
    ['inspection',inspection],
    ['support',support],
    ['inspection',{sections:[{...inspection,checks:[{...check,evidence:[{sourceId:'s1',quote:4}]}]}]}],
    ['support',{sections:[{...support,claims:[{...support.claims[0],references:[{quote:'study',target:4}]}]}]}],
    ['judgment',{...cases.judgment,judgments:[{...cases.judgment.judgments[0],status:'invented'}]}],
    ['extraction',{evidence:[{sourceId:'s',fieldPath:['name']}]}],
    ['conditions',{conditions:[{id:'x',valid:'yes',reason:'x'}]}],
    ['profile',{slots:[{...cases.profile.slots[0],group:'bad'}]}],
    ['unknown',{}]
  ]) assert.throws(()=>validateGraniteStage(stage,value),{message:'model_output_invalid'});
});
