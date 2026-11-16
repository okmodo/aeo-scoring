import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {scoreAudit,scoreAuditV1} from './scoring.mjs';
import {extract} from './retrieval.mjs';
import {HtmlTestRewriter} from './html-product-test-helper.mjs';
import {buildSemanticRequest,validateSemanticResponse} from './semantic-assessment.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const check=(r,id)=>r.criteria.flatMap(c=>c.subchecks).find(s=>s.id===id);
async function fixture(){
 const snapshot={url:'https://shop.example/products/everyday-tshirt',observedAt:'2026-11-15T00:00:00.000Z',body:read('./fixtures/revised-s1-s2/complete-shirt-v2.html'),htmlLimited:null,...JSON.parse(read('./fixtures/complete-engine/support.json'))};
 const extracted=await extract(snapshot,{HTMLRewriter:HtmlTestRewriter});
 const prepared=buildSemanticRequest(snapshot,extracted,{category:'basic-tshirts',currency:'USD'});
 const semantic={...validateSemanticResponse(prepared,JSON.parse(read('./fixtures/complete-engine/reviewed-judgments.json'))),status:'assessed',model:'independently-reviewed-synthetic-judgments'};
 return{snapshot,extracted,semantic};
}
test('default report uses rubric v2 and only revised S1/S2 check IDs',async()=>{
 const{snapshot,extracted,semantic}=await fixture(),r=scoreAudit(snapshot,extracted,{semantic});
 assert.equal(r.rubricVersion,'2.0.0');assert.equal(r.engineVersion,'2.0.0');
 assert.equal(r.coverage.total,40);assert.equal(check(r,'S1.identity'),undefined);assert.equal(check(r,'S2.core-properties'),undefined);
 assert.equal(r.status,'complete');assert.equal(r.score.structure,20);assert.equal(r.score.content,58.125);assert.equal(r.score.total,78.125);
 assert.equal(check(r,'S1.configuration').status,'not_applicable');assert.equal(check(r,'S2.identifiers').status,'not_applicable');
 for(const id of ['S1.delivery','S1.readability','S1.scope','S1.supporting-access'])assert.equal(check(r,id).fraction,1);
 const ids=new Set(r.evidence.map(e=>e.id));for(const s of r.criteria.flatMap(c=>c.subchecks))for(const id of s.evidenceIds)assert.ok(ids.has(id));
 const affected=r.fixes.flatMap(f=>f.checkIds);assert.equal(affected.length,new Set(affected).size);
 assert.equal(r.score.total+r.fixes.reduce((n,f)=>n+(f.recoverablePoints||0),0),100);
 const expected=JSON.parse(read('../contracts/v1/examples/assessment-engine-v2-complete.json'));assert.deepEqual(r,expected.report);
});
test('content and S3-S8 fractions remain identical to explicit v1 replay',async()=>{
 const{snapshot,extracted,semantic}=await fixture(),old=scoreAuditV1(snapshot,extracted,{semantic}),current=scoreAudit(snapshot,extracted,{semantic});
 const statuses=r=>r.criteria.filter(c=>!['S1','S2'].includes(c.id)).flatMap(c=>c.subchecks.map(s=>({id:s.id,status:s.status,fraction:s.fraction,points:s.points})));
 assert.deepEqual(statuses(current),statuses(old));assert.equal(old.rubricVersion,'1.0.0');assert.equal(old.engineVersion,'1.1.0');
});
test('changing semantic content completeness cannot change S1 or S2',async()=>{
 const{snapshot,extracted,semantic}=await fixture();const before=scoreAudit(snapshot,extracted,{semantic});const changed=structuredClone(semantic);
 for(const id of ['C1.explanation','C2.essential','C2.supporting','C3.price','C3.availability'])changed.findings[id]={status:'not_measured',reason:'Uncertain synthetic semantic inspection.'};
 const after=scoreAudit(snapshot,extracted,{semantic:changed});
 const s=r=>r.criteria.filter(c=>['S1','S2'].includes(c.id)).flatMap(c=>c.subchecks.map(x=>({id:x.id,status:x.status,fraction:x.fraction,points:x.points})));
 assert.deepEqual(s(before),s(after));assert.equal(after.score,null);
});
test('truncation and unsupported inspection never produce a final numerical score',async()=>{
 const{snapshot,extracted,semantic}=await fixture();const r=scoreAudit({...snapshot,htmlLimited:'bytes'},extracted,{semantic});
 assert.equal(r.status,'incomplete');assert.equal(r.score,null);for(const s of r.criteria.find(c=>c.id==='S1').subchecks)assert.equal(s.status,'not_measured');
});
test('correct structured modeling earns S2 credit independently of visible agreement and descriptive completeness',async()=>{
 const{snapshot,extracted,semantic}=await fixture();
 extracted.jsonLd=[JSON.stringify({'@context':'https://schema.org','@type':'Product',url:snapshot.url,name:'Acme Everyday T-shirt',gtin12:'036000291452',offers:{'@type':'Offer',price:77,priceCurrency:'USD',availability:'https://schema.org/InStock'}})];
 const r=scoreAudit(snapshot,extracted,{semantic}),s2=r.criteria.find(c=>c.id==='S2');
 assert.equal(s2.points,9);assert.equal(s2.complete,true);
 for(const id of ['S2.syntax','S2.entity','S2.offer','S2.identifiers'])assert.equal(check(r,id).fraction,1);
 assert.equal(check(r,'S2.variants').status,'not_applicable');
 assert.equal(check(r,'S3.price').fraction,0);assert.equal(check(r,'C3.price').fraction,1);
 assert.equal(check(r,'S2.core-properties'),undefined);
 // The markup intentionally lacks description and image; their completeness is not an S2 check.
 const fullFields=structuredClone(extracted);const p=JSON.parse(fullFields.jsonLd[0]);p.description='A casual cotton T-shirt for everyday use.';p.image='https://shop.example/shirt.jpg';fullFields.jsonLd=[JSON.stringify(p)];
 const second=scoreAudit(snapshot,fullFields,{semantic});
 assert.deepEqual(second.criteria.find(c=>c.id==='S2').subchecks.map(s=>[s.id,s.status,s.fraction,s.points]),s2.subchecks.map(s=>[s.id,s.status,s.fraction,s.points]));
});
