import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_MODEL_CONFIG as config, validateAiModelConfig } from './ai-model-config.mjs';
import { createTerraByokProvider } from './terra-byok-provider.mjs';

const input={messages:[{role:'user',content:'fixture'}],max_tokens:1000,temperature:0,stream:false};
const success={success:true,result:{object:'response',status:'completed',error:null,incomplete_details:null,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'{"ok":true}'}]}]}};
const reply = value => new Response(JSON.stringify(value),{status:200});
test('BYOK request uses bounded, configured envelope and normalizes content',async()=>{
 let seen; const signal=new AbortController().signal;
 const provider=createTerraByokProvider({AUDIT_AI_GATEWAY_TOKEN:'test-token'},{fetch:async(url,options)=>{seen={url,options};return reply(success);}});
 assert.deepEqual(await provider.run(config.model,input,{signal}),{response:'{"ok":true}'});
 assert.equal(seen.url,config.endpoint); assert.equal(seen.options.signal,signal); assert.equal(seen.options.redirect,'error');
 assert.deepEqual(seen.options.headers,{Authorization:'Bearer test-token','Content-Type':'application/json','cf-aig-gateway-id':'openai','cf-aig-no-wholesale':'true','cf-aig-max-attempts':'1'});
 assert.deepEqual(JSON.parse(seen.options.body),{model:config.model,input:{input:input.messages,max_output_tokens:1000,reasoning:{effort:'low'},text:{format:{type:'json_object'}},stream:false}});
});
test('invalid configuration and input fail closed',async()=>{
 assert.throws(()=>validateAiModelConfig({...config,endpoint:'https://example.com'}),/invalid_model_config/);
 assert.doesNotMatch(JSON.stringify(config),/token|secret|key/i);
 let calls=0;const provider=createTerraByokProvider({AUDIT_AI_GATEWAY_TOKEN:'test'},{fetch:async()=>{calls++;return reply(success);}});
 await assert.rejects(provider.run('wrong',input)); await assert.rejects(provider.run(config.model,{...input,max_tokens:4001}));
 await assert.rejects(provider.run(config.model,{...input,messages:[{role:'user',content:'x'.repeat(61440)}]}),/request_limit/); assert.equal(calls,0);
});
test('provider rejects HTTP, malformed, refused, truncated, oversized and broken streams without exposing details',async()=>{
 const responses=[new Response('secret',{status:500}),new Response('{'),reply({success:false}),reply({success:true,result:{...success.result,status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}}),reply({success:true,result:{...success.result,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'refusal',refusal:'secret'}]}]}}),reply({success:true,result:{...success.result,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'[]'}]}]}}),new Response('x'.repeat(65537)),new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));c.error(new Error('secret'));}}))];
 for(const response of responses){const provider=createTerraByokProvider({AUDIT_AI_GATEWAY_TOKEN:'secret'},{fetch:async()=>response});await assert.rejects(provider.run(config.model,input),e=>e.message==='model_provider_failure');}
});
test('network failures are sanitized and never retried',async()=>{
 let calls=0; const provider=createTerraByokProvider({AUDIT_AI_GATEWAY_TOKEN:'secret'},{fetch:async()=>{calls++;throw new Error('secret');}});
 await assert.rejects(provider.run(config.model,input),{message:'model_provider_failure'});assert.equal(calls,1);
});
test('approved settings are fixed by the configuration fixture and safe alternatives validate',()=>{
 assert.deepEqual(config,{endpoint:'https://api.cloudflare.com/client/v4/accounts/495d788b994070692b54c46945a5e577/ai/run',model:'openai/gpt-6.1-terra',gatewayId:'openai',apiFormat:'responses',reasoningEffort:'low',responseFormat:'json_object',stream:false,timeoutMs:30000,stageCaps:{extraction:1000,identity:512,proposal:1800,review:1000,inspection:2500,supportInspection:2500,judgment:4000},requestMaxBytes:61440,outputMaxBytes:65536});
 assert.doesNotThrow(()=>validateAiModelConfig({...config,model:'openai/another-model',timeoutMs:20000,stageCaps:{...config.stageCaps,judgment:3000},outputMaxBytes:32000}));
 for(const invalid of [{...config,model:'https://evil.test'}, {...config,reasoningEffort:'high'}, {...config,stream:true}, {...config,timeoutMs:30001}, {...config,stageCaps:{...config.stageCaps,judgment:4001}}, {...config,requestMaxBytes:61441}, {...config,outputMaxBytes:0}, {...config,secret:'x'}]) assert.throws(()=>validateAiModelConfig(invalid),/invalid_model_config/);
});
test('partial response streams fail and abort reaches the fetch operation',async()=>{
 const partial=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"success":true'));c.close();}}));
 await assert.rejects(createTerraByokProvider({AUDIT_AI_GATEWAY_TOKEN:'test'},{fetch:async()=>partial}).run(config.model,input),{message:'model_provider_failure'});
 const controller=new AbortController(); let seen;
 const provider=createTerraByokProvider({AUDIT_AI_GATEWAY_TOKEN:'test'},{fetch:async(_url,{signal})=>{seen=signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}});
 const pending=provider.run(config.model,input,{signal:controller.signal});controller.abort();
 await assert.rejects(pending,{message:'model_provider_failure'});assert.equal(seen.aborted,true);
});
test('bounded diagnostics report only safe numeric metadata and failures reject all noncompleted output',async()=>{
 const diagnostics=[]; const run=async response=>createTerraByokProvider({AUDIT_AI_GATEWAY_TOKEN:'secret'},{fetch:async()=>response,onDiagnostic:d=>diagnostics.push(d)}).run(config.model,input);
 for(const status of [401,400,429,402]) await assert.rejects(run(new Response(JSON.stringify({errors:[{code:7004,message:'merchant secret'}]}),{status,headers:{'retry-after':'12'}})),{message:'model_provider_failure'});
 assert.deepEqual(diagnostics,[401,400,429,402].map(status=>({phase:'http',status,retryAfter:12,codes:[7004]})));
 const cases=[{...success.result,status:'incomplete'}, {...success.result,incomplete_details:{reason:'max_output_tokens'}}, {...success.result,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'refusal',refusal:'secret'}]}]}, {...success.result,output:[{type:'unknown'}]}, {...success.result,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'{"truncated":'}]}]}];
 for(const result of cases) await assert.rejects(run(reply({success:true,result})),{message:'model_provider_failure'});
 assert.doesNotMatch(JSON.stringify(diagnostics),/secret|merchant/);
});

test('reasoning metadata is ignored while completed assistant text remains required',async()=>{
 const run=async result=>createTerraByokProvider({AUDIT_AI_GATEWAY_TOKEN:'test'},{fetch:async()=>reply({success:true,result}),onDiagnostic:()=>{}}).run(config.model,input);
 const reasoning={type:'reasoning',summary:[]};
 assert.deepEqual(await run({...success.result,output:[reasoning,...success.result.output]}),{response:'{"ok":true}'});
 for(const output of [[reasoning],[{...reasoning,status:'incomplete'},...success.result.output],[{type:'function_call'},...success.result.output]]) await assert.rejects(run({...success.result,output}),{message:'model_provider_failure'});
 const diagnostics=[];let calls=0;
 await assert.rejects(createTerraByokProvider({}, {fetch:async()=>{calls++;return reply(success)},onDiagnostic:d=>diagnostics.push(d)}).run(config.model,input),{message:'model_provider_failure'});
 assert.equal(calls,0);assert.deepEqual(diagnostics,[{phase:'validation'}]);
});
test('default fetch keeps its receiver and token whitespace is normalized',async()=>{
 const original=globalThis.fetch; let seen;
 try {
  globalThis.fetch=async function(url,options){assert.equal(this,globalThis);seen={url,options};return reply(success);};
  const provider=createTerraByokProvider({AUDIT_AI_GATEWAY_TOKEN:'  token\r\n'});
  assert.deepEqual(await provider.run(config.model,input),{response:'{"ok":true}'});
  assert.equal(seen.options.headers.Authorization,'Bearer token');
 } finally { globalThis.fetch=original; }
});
test('fetch exception classifications are closed and never disclose error content',async()=>{
 const cases=[[new TypeError('Illegal invocation: secret merchant'),'illegal_invocation'],[new TypeError('Invalid header value secret'),'invalid_header'],[new TypeError('different request I/O context secret'),'io_context'],[new TypeError('fetch failed secret'),'network'],[new TypeError('secret merchant'),'unknown'],[new Error('Illegal invocation secret'),'unknown']];
 for(const [error,expected] of cases){
  const diagnostics=[];let calls=0;
  const provider=createTerraByokProvider({AUDIT_AI_GATEWAY_TOKEN:'secret'},{fetch:async()=>{calls++;throw error;},onDiagnostic:value=>diagnostics.push(value)});
  await assert.rejects(provider.run(config.model,input),{message:'model_provider_failure'});
  assert.equal(calls,1);assert.deepEqual(diagnostics,[{phase:'fetch',class:expected}]);assert.doesNotMatch(JSON.stringify(diagnostics),/secret|merchant/);
 }
});
