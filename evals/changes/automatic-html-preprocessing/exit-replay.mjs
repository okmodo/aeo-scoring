import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {restoreFixture,createNativeBridge} from './exit-helper.mjs';
import {createBrowserContentWorkflow} from '../../../backend/browser-content-workflow.mjs';
const data=JSON.parse(await readFile(new URL('./exit-export.json',import.meta.url),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const original=Buffer.from(data.objects.find(([k])=>k.endsWith('/html'))[1],'base64');
const preparedBytes=Buffer.from(data.objects.find(([k])=>k.endsWith('/prepared'))[1],'base64');
const prepared=JSON.parse(preparedBytes);
assert.equal(data.row.prepared_state,'ready'); assert.equal(data.row.inputs_state,null);
assert.equal(hash(original),data.row.html_hash); assert.equal(hash(preparedBytes),data.row.prepared_hash);
assert.equal(hash(prepared.html),data.expected.outputSha256); assert.equal(Buffer.byteLength(prepared.html),data.expected.outputBytes);
const native=await createNativeBridge();
async function run(fixture, expectFailure){
 let retrieval=0,preprocessing=0,extraction=0;
 const flow=createBrowserContentWorkflow({db:fixture.db,snapshots:fixture.snapshots,now:fixture.now,guard:{},binding:{quickAction(){retrieval++;throw Error('retrieval forbidden');}},preprocess(){preprocessing++;throw Error('preprocessing forbidden');},extractPage(args){extraction++;return native.call('extract',args,fixture.now());}});
 let result,error;
 try { result=await flow.read(data.audit.id); } catch(e){error=e;}
 assert.equal(retrieval,0);assert.equal(preprocessing,0);
 if(expectFailure){assert.equal(error?.code,expectFailure);assert.equal(extraction,0);assert.equal(fixture.sqlite.prepare('SELECT inputs_state FROM retained_snapshots WHERE audit_id=?').get(data.audit.id).inputs_state,null);return {error:error.code,retrieval,preprocessing,extraction};}
 if(error)throw error;
 const row=fixture.sqlite.prepare('SELECT * FROM retained_snapshots WHERE audit_id=?').get(data.audit.id);
 const retained=fixture.objects.get(data.row.object_prefix+'/html');
 const inputs=await fixture.snapshots.readAssessment(data.audit.id,'inputs');
 assert.equal(row.inputs_state,'ready');assert.equal(row.expires_at,data.row.expires_at);assert.equal(row.html_hash,data.row.html_hash);assert.equal(row.prepared_hash,data.row.prepared_hash);
 assert.deepEqual(Buffer.from(retained),original);assert.equal(hash(result.rawHtml),data.expected.outputSha256);
 assert.equal(result.source.objectKey,data.row.object_prefix+'/html');assert.equal(result.source.sha256,data.expected.sourceSha256);assert.equal(result.source.expiresAt,data.audit.expiresAt);
 assert.deepEqual(inputs.snapshot.preprocessing,prepared.preprocessing);assert.equal(prepared.preprocessing.sourceObjectKey,result.source.objectKey);assert.equal(prepared.preprocessing.sourceSha256,result.source.sha256);assert.equal(prepared.preprocessing.sourceBytes,original.length);assert.equal(prepared.preprocessing.expiresAt,result.source.expiresAt);
 assert.equal(extraction,1);
 return {inputsState:row.inputs_state,sourceSha256:hash(retained),preparedArtifactSha256:row.prepared_hash,cleanedSha256:hash(result.rawHtml),sourceObjectKey:result.source.objectKey,expiresAt:row.expires_at,retrieval,preprocessing,extraction};
}
try {
 const good=restoreFixture(data);let continuation;try{continuation=await run(good);}finally{good.sqlite.close();}
 const tampered=restoreFixture(data);let tamperedResult;try{const key=data.row.object_prefix+'/prepared';const b=tampered.objects.get(key);b[10]^=1;tamperedResult=await run(tampered,'snapshot_corrupt');}finally{tampered.sqlite.close();}
 const expired=restoreFixture(data);let expiredResult;try{expired.setNow(data.audit.expiresAt);expiredResult=await run(expired,'snapshot_expired');}finally{expired.sqlite.close();}
 const result={sourceCommit:'0bd4e02',boundary:data.scenario,clock:{kind:'synthetic',initial:data.now,expiry:data.audit.expiresAt},command:'/private/tmp/node-v24.11.1-darwin-arm64/bin/node evals/changes/automatic-html-preprocessing/exit-replay.mjs',executionHistory:[{environment:'sandbox',outcome:'EPERM listening on 127.0.0.1 during Miniflare startup'},{environment:'approved local loopback',outcome:'passed'}],continuation,tamperedPrepared:tamperedResult,expiredAtBoundary:expiredResult,limitations:['Synthetic exported data and virtual clock; no claim about real capture time.','In-memory SQLite and object store; native extractor runs in local Miniflare.','No production, network, model, or browser retrieval calls.']};
 await writeFile(new URL('./exit-observations.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await native.close();}
