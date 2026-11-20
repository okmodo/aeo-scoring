// Fixed-capture private manual validation; never invoked by CI or production.
import {createAnalyticsAllowanceGuard} from '../../../backend/analytics-allowance.mjs';
import {createR2AllowanceGuard} from '../../../backend/allowance-r2.mjs';
import {createSnapshotStore} from '../../../backend/snapshot-store.mjs';
import {extract} from '../../../backend/retrieval.mjs';
import {prepareAssessmentSources} from '../../../backend/assessment-sources.mjs';
import {assessRetainedRubric} from '../../../backend/ai-rubric-assessment.mjs';
import {scoreAudit} from '../../../backend/scoring.mjs';
const id='07353075-578b-4eff-90d4-87a3ab8f4a7f';
const expected='19052651e62570a19971ffa99b7abaf2809bc85475ba6e9557be9dbaedf57422';
const encoder=new TextEncoder();
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');
export default {async fetch(request,env){
 if(request.method!=='POST'||new URL(request.url).pathname!=='/validate-cleaned-faherty'||new URL(request.url).search)return new Response(null,{status:404});
 const expiry=Number(env.AUDIT_VALIDATION_EXPIRES_AT),now=Date.now();
 if(!Number.isSafeInteger(expiry)||expiry<=now||expiry>now+3600000)return new Response(null,{status:401});
 const supplied=request.headers.get('authorization')||'';
 if(!/^Bearer [a-f0-9]{64}$/.test(supplied)||!/^[a-f0-9]{64}$/.test(env.AUDIT_VALIDATION_TOKEN_SHA256||''))return new Response(null,{status:401});
 const actual=encoder.encode(await digest(supplied.slice(7))),required=encoder.encode(env.AUDIT_VALIDATION_TOKEN_SHA256);
 if(!crypto.subtle.timingSafeEqual(actual,required))return new Response(null,{status:401});
 if(!/^[a-f0-9-]{36}$/.test(env.AUDIT_VALIDATION_RUN_ID||''))return new Response(null,{status:401});
 const config={accountId:env.AUDIT_BILLING_ACCOUNT_ID,subscriptionId:env.AUDIT_BILLING_SUBSCRIPTION_ID,token:env.AUDIT_USAGE_READ_TOKEN};
 const allowance=createAnalyticsAllowanceGuard(env.AUDIT_DB,config),runId='cleaned-html-live-'+env.AUDIT_VALIDATION_RUN_ID;
 const grant=await allowance.reserve({id:runId,costs:{requests:1,cpuMs:2000,d1Reads:100000,d1Writes:250,d1StorageBytes:512*1024}});
 if(!grant?.accepted||grant.duplicate!==false)return Response.json({status:'denied',reason:grant?.reason??'duplicate'},{status:429});
 const calls=[];let result;
 try{
  const deadlineAt=Date.now()+25000;
  const snapshots=createSnapshotStore({db:env.AUDIT_DB,bucket:env.AUDIT_SNAPSHOTS,allowance:createR2AllowanceGuard(env.AUDIT_DB,config)});
  const capture=await snapshots.read(id),html=new TextDecoder('utf-8',{fatal:true}).decode(capture.rawHtml);
  if(await digest(html)!==expected||capture.snapshot.preprocessing?.outputSha256!==expected)throw new Error('capture_identity_mismatch');
  const extracted=await extract({...capture.snapshot,body:capture.rawHtml});
  const initialExtracted={productHtml:null,jsonLd:[],coverage:{html:false,usable:false,jsonLdTruncated:true}};
  const snapshot={...capture.snapshot,rawHtml:capture.rawHtml,browser:{version:'browser-content-v2',captureType:'content-api',renderedHtml:html,initialExtracted,coverage:{complete:extracted.productHtml?.complete===true&&extracted.coverage?.html===true,initialAvailable:false,initialLimited:false,renderedLimited:false}}};
  const bundle=await prepareAssessmentSources(snapshot,extracted);
  const report=scoreAudit(snapshot,extracted,{initialExtracted,requireAiAssessment:true});
  const AI={async run(model,input){const call={model,requestBytes:encoder.encode(JSON.stringify(input)).length,startedAt:Date.now(),status:'pending'};calls.push(call);try{const response=await env.AUDIT_AI.run(model,input);call.status='returned';call.finishedAt=Date.now();call.usage=response?.usage??null;call.response=response?.response??response?.choices?.[0]?.message?.content??null;return response;}catch{call.status='provider_failed';call.finishedAt=Date.now();throw Error('provider_failed');}}};
  const assessment=await assessRetainedRubric({AI,allowance,snapshot,extracted,report,deadlineAt,calibrationApproved:true});
  const scored=assessment.status==='assessed'?scoreAudit(snapshot,extracted,{initialExtracted,aiAssessment:assessment.assessment}):report;
  result={status:assessment.status,reason:assessment.reason,source:{auditId:id,sha256:expected,bytes:capture.rawHtml.length,sections:bundle.sources.length,coverage:bundle.coverage},stages:assessment.stages,report:scored,calls};
 }catch(error){result={status:'failed',code:['snapshot_expired','snapshot_corrupt','snapshot_admission'].includes(error.code)?error.code:'validation_unavailable',calls};}
 const settlement=await allowance.settle({id:runId});
 return Response.json({...result,runId,settlement},{headers:{'cache-control':'no-store'}});
}};
