import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSemanticRequest } from './semantic-assessment.mjs';
import { buildContentFactsRequest, decodeContentFacts } from './content-facts.mjs';

const fixture = count => buildSemanticRequest(
    {url:'https://example.test/item',policies:{shipping:{state:'read',url:'https://example.test/shipping',extraction:{complete:true,blocks:[{text:'Shipping takes three days.',location:'shipping'}]}}}},
    {productHtml:{complete:true,identity:'Example shoe',blocks:Array.from({length:count},(_,i)=>({text:`Product detail ${i}: ${'A descriptive phrase about the item. '.repeat(8)}`,location:`detail-${i}`}))}},
    {category:'running-shoes'}
);
const size = value => Buffer.byteLength(JSON.stringify(value));
const outputFor = request => {
    const payload=JSON.parse(request.messages[1].content);
    return {roles:Object.fromEntries(payload.candidates.map(c=>[c.roleId,[]])), inspections:[], conditionChecks:Object.fromEntries(payload.conditionKeys.map(k=>[k,'unknown']))};
};
test('small request retains its historical bytes',()=>{
    const request=buildContentFactsRequest(fixture(1));
    assert.equal(JSON.parse(request.messages[1].content).packingVersion,undefined);
    assert.equal(createHash('sha256').update(JSON.stringify(request)).digest('hex'),'3406d7cb19de54ad4276e4d3a5db38e4325569923b23c3ca248a3d50967fa2b3');
});
test('overflow packing preserves complete observations, role eligibility, definitions and replay validation',()=>{
    let prepared, request;
    for (let n=30;n<300;n++) {
        try { const p=fixture(1), source=p.payload.sources.find(s=>s.scope==='product');
            for(let i=0;i<n;i++) { const text=`Detail ${i}: ${'A descriptive phrase about the item '.repeat(8)}`; const start=source.text.length; source.text+=text; source.blocks.push({start,end:source.text.length,location:`synthetic-${i}`}); }
            const r=buildContentFactsRequest(p); if (JSON.parse(r.messages[1].content).packingVersion) { prepared=p;request=r;break; } } catch { break; }
    }
    assert.ok(request,'synthetic fixture must enter the packing branch');
    assert.ok(size(request)<=60*1024);
    assert.deepEqual(request,buildContentFactsRequest(prepared));
    const payload=JSON.parse(request.messages[1].content);
    for (const source of prepared.payload.sources) for (const block of source.blocks.filter(b=>b.location.startsWith('synthetic-'))) assert.ok(payload.observations.some(o=>o.text===source.text.slice(block.start,block.end).trim())); 
    const roles=request.response_format.json_schema.properties.roles;
    for (const candidate of payload.candidates) {
        const slot=roles.properties[candidate.roleId];
        assert.deepEqual(candidate.ids,slot.items.enum ?? slot.items.properties.id.enum);
    }
    assert.equal(payload.category.questions.length,prepared.payload.category.decisionSupport.length);
    const output=outputFor(request);
    const result=decodeContentFacts(prepared,request,output,{requireRoleSlots:true,requireConditionChecks:true});
    assert.equal(result.observations.length,payload.observations.length);
    assert.ok(result.observations.some(o=>o.scope==='shipping'));
    assert.ok(result.inspections.every(i=>i.status!=='absent'));
    const invalid=structuredClone(output); invalid.roles[payload.candidates[0].roleId]=['q999999'];
    assert.throws(()=>decodeContentFacts(prepared,request,invalid,{requireRoleSlots:true}),/Invalid or duplicate/);
    assert.throws(()=>decodeContentFacts(prepared,{...request,temperature:1},output),/mismatch/);
    const shipping=result.observations.find(o=>o.scope==='shipping');
    assert.throws(()=>decodeContentFacts(prepared,request,{facts:[{kind:'attribute',key:'size',quoteIds:[shipping.id]}],inspections:[]}),/scope/);
});
test('irreducible oversized evidence fails explicitly',()=>{
    const p=fixture(1), source=p.payload.sources.find(s=>s.scope==='product');
    for(let i=0;i<400;i++) { const start=source.text.length; source.text+=`Detail ${i}: ${'Long descriptive item text '.repeat(20)}`; source.blocks.push({start,end:source.text.length,location:'detail'}); }
    assert.throws(()=>buildContentFactsRequest(p),/exceeds input budget/);
});
