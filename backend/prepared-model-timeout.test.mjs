import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {callRubricModel,MODEL_RESPONSE_TIMEOUT_MS} from './ai-rubric-assessment.mjs';
const input={messages:[{role:'user',content:'Synthetic timing fixture'}],max_tokens:1000};
const result={response:{evidence:[]},usage:{prompt_tokens:100,completion_tokens:100}};
function fixture(remaining=()=>25000){let resolve;const settlements=[];const args={AI:{run:()=>new Promise(r=>{resolve=r})},allowance:{reserve:async()=>({accepted:true,duplicate:false}),settle:async r=>{settlements.push(r);return{accepted:true}}},now:()=>1000,input,remaining};return{args,settlements,respond:()=>resolve(result)}}
test('the measured 12.688-second response succeeds before the new 15-second deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});assert.equal(MODEL_RESPONSE_TIMEOUT_MS,15000);
 const f=fixture(),pending=callRubricModel(f.args);await nextTurn();t.mock.timers.tick(12688);f.respond();
 assert.deepEqual(await pending,{evidence:[]});assert.equal(f.settlements.length,1);assert.ok(f.settlements[0].costs.aiNeurons>0);
});
test('no response times out at 15 seconds and leaves uncertain usage unsettled',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture();let finished=false;
 const pending=callRubricModel(f.args);const rejected=assert.rejects(pending,{message:'model_timeout'}).then(()=>{finished=true});await nextTurn();
 t.mock.timers.tick(14999);await nextTurn();assert.equal(finished,false);t.mock.timers.tick(1);await rejected;assert.equal(f.settlements.length,0);
});
test('a shorter remaining invocation deadline still takes precedence',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(()=>4000);let finished=false;
 const rejected=assert.rejects(callRubricModel(f.args),{message:'model_timeout'}).then(()=>{finished=true});await nextTurn();
 t.mock.timers.tick(3999);await nextTurn();assert.equal(finished,false);t.mock.timers.tick(1);await rejected;assert.equal(f.settlements.length,0);
});
