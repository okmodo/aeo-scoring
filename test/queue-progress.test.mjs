import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalReview} from '../scripts/local-progress-review.mjs';

const auth={'authorization':'Bearer review123','content-type':'application/json'};
const req=(path,init={})=>new Request('http://localhost'+path,{headers:auth,...init});

test('local fixture service authenticates before accessing the queue',async()=>{
  const review=createLocalReview({delayMs:0,autoConsume:false});
  try {
    assert.equal((await review.request(new Request('http://localhost/api/v1/audits',{method:'POST',body:'{}'}))).status,401);
    assert.equal((await review.request(new Request('http://localhost/api/v1/audits/missing'))).status,401);
    assert.equal((await review.request(req('/api/v1/preview-access',{method:'POST'}))).status,204);
    assert.equal(review.sql.prepare('SELECT COUNT(*) AS n FROM audits').get().n,0);
  } finally {review.close();}
});

test('real queue deliveries expose durable progress and publish only after assessment',async()=>{
  const review=createLocalReview({delayMs:0,autoConsume:false});
  try {
    const post=await review.request(req('/api/v1/audits',{method:'POST',body:JSON.stringify({url:'https://example.com/kettle'})}));
    assert.equal(post.status,202);const initial=await post.json();
    assert.equal(initial.progress.auditId,initial.id);
    assert.equal(initial.progress.revision,0);
    assert.deepEqual(initial.progress.events,[]);
    const poll=async()=>{const before=review.operations.length;const result=await (await review.request(req(initial.statusUrl))).json();
      const joins=review.operations.slice(before).filter(query=>/FROM audit_queue_jobs q/i.test(query));assert.equal(joins.length,1);return result;};
    let previous=await poll(),first;
    assert.equal(previous.status,'pending');
    const future={...review.messages[0],sequence:review.messages[0].sequence+1};
    await review.deliver(future);
    assert.deepEqual((await poll()).progress,previous.progress);
    for(let n=0;review.messages.length&&n<40;n++) {
      const body=review.messages.shift();first??=body;
      assert.deepEqual(await review.deliver(body),{acked:true,retried:false});
      const current=await poll();
      assert.ok(current.progress, 'queued audit exposes progress');
      if(previous.progress) assert.ok(current.progress.revision>=previous.progress.revision);
      if(current.status==='pending') assert.equal(current.report,null);
      previous=current;
    }
    assert.equal(review.messages.length,0);
    assert.equal(review.sql.prepare('SELECT COUNT(*) AS n FROM model_attempts').get().n,1,'keyed model fixture ran once');
    const model=review.sql.prepare('SELECT outcome,measured FROM model_attempts').get();
    assert.equal(model.outcome,'response_received','fixture response is parsed rather than provider failure');
    assert.ok(model.measured>0,'fixture produces validated findings');
    assert.equal(review.sql.prepare('SELECT COUNT(*) AS n FROM model_question_results').get().n,13,'all keyed answers persisted');
    assert.equal(previous.status,'incomplete');assert.ok(previous.report);
    const stages=new Set(previous.progress.events.map(event=>event.stage));
    for(const stage of ['retrieval','preparation','assessment','scoring']) assert.ok(stages.has(stage),stage);
    const before=JSON.stringify(previous.progress);assert.deepEqual(await review.deliver(first),{acked:true,retried:false});
    assert.equal(JSON.stringify((await poll()).progress),before);
  } finally {review.close();}
});

test('dead-letter after preparation publishes a partial report',async()=>{
  const review=createLocalReview({delayMs:0,autoConsume:false});
  try {
    const post=await review.request(req('/api/v1/audits',{method:'POST',body:JSON.stringify({url:'https://example.com/dead-letter'})}));
    const initial=await post.json();
    await review.deliver(review.messages.shift());await review.deliver(review.messages.shift());
    assert.deepEqual(await review.deliver(review.messages.shift(),{deadLetter:true}),{acked:true,retried:false});
    const final=await (await review.request(req(initial.statusUrl))).json();
    assert.equal(final.status,'incomplete');assert.equal(final.report.score,null);
  } finally {review.close();}
});


test('dead-letter before capture produces failure without a report',async()=>{
  const review=createLocalReview({delayMs:0,autoConsume:false});
  try {
    const post=await review.request(req('/api/v1/audits',{method:'POST',body:JSON.stringify({url:'https://example.com/failed'})}));
    const initial=await post.json();
    assert.deepEqual(await review.deliver(review.messages.shift(),{deadLetter:true}),{acked:true,retried:false});
    const final=await (await review.request(req(initial.statusUrl))).json();
    assert.equal(final.status,'unable_to_assess');assert.equal(final.report,null);
  } finally {review.close();}
});
