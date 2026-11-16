import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {scoreReference} from '../scripts/scoring-foundations.mjs';
const read=p=>JSON.parse(readFileSync(new URL('../'+p,import.meta.url)));
const rubric=read('config/rubric.v2.json'), prior=read('config/rubric.v1.json'), categories=read('config/categories.v1.2.json');
const all=()=>Object.fromEntries(rubric.criteria.flatMap(c=>c.subchecks.map(s=>[s.id,{status:'measured',fraction:1,evidence:'e1'}])));
const exclude=rule=>({status:'not_applicable',rule,justification:'Explicit complete source proof.',evidence:'e1',url:'https://shop.example/item',location:'main/p'});
test('v2 freezes only the approved S1/S2 identities and weights',()=>{
 assert.equal(rubric.version,'2.0.0');
 assert.deepEqual(rubric.criteria[0].subchecks.map(s=>[s.id,s.maxPoints]),[['S1.delivery',4],['S1.readability',3],['S1.scope',3],['S1.configuration',2],['S1.supporting-access',1]]);
 assert.deepEqual(rubric.criteria[1].subchecks.map(s=>[s.id,s.maxPoints]),[['S2.syntax',2],['S2.entity',2],['S2.offer',2],['S2.identifiers',2],['S2.variants',1]]);
 assert.deepEqual(rubric.criteria.slice(2),prior.criteria.slice(2));
 assert.equal(rubric.criteria.flatMap(c=>c.subchecks).length,40);
 for(const [pillar,max] of [['structure',40],['content',60]])assert.equal(rubric.criteria.filter(c=>c.pillar===pillar).reduce((n,c)=>n+c.maxPoints,0),max);
 for(const c of rubric.criteria)assert.equal(c.subchecks.reduce((n,s)=>n+s.maxPoints,0),c.maxPoints);
});
test('revised checks allow only full, half and zero credit with deduction evidence',()=>{
 for(const fraction of [0,0.5,1]){const checks=all();checks['S1.delivery']={status:'measured',fraction,evidence:'e1'};const r=scoreReference(rubric,categories,{category:'running-shoes',checks});assert.equal(r.finalScore,96+4*fraction);}
 const checks=all();checks['S2.syntax'].fraction=0.25;assert.throws(()=>scoreReference(rubric,categories,{category:'running-shoes',checks}),/Invalid revised credit/);
 checks['S2.syntax']={status:'measured',fraction:0};assert.throws(()=>scoreReference(rubric,categories,{category:'running-shoes',checks}),/Missing deduction evidence/);
});
test('evidence-bound exclusions redistribute only within their criterion',()=>{
 const checks=all();checks['S1.configuration']=exclude('single_configuration');checks['S1.delivery'].fraction=0.5;
 checks['S2.identifiers']=exclude('no_identifiers_assigned');checks['S2.variants']=exclude('single_configuration');checks['S2.syntax'].fraction=0.5;
 const r=scoreReference(rubric,categories,{category:'running-shoes',checks});
 assert.equal(r.criteria.S1.denominator,11);assert.equal(r.criteria.S1.points,9*13/11);
 assert.equal(r.criteria.S2.denominator,6);assert.equal(r.criteria.S2.points,5*9/6);
 assert.equal(r.criteria.C1.points,10);assert.equal(r.criteria.S3.points,9);
 for(const id of ['S1.configuration','S2.identifiers']){const copy=structuredClone(checks);delete copy[id].evidence;assert.throws(()=>scoreReference(rubric,categories,{category:'running-shoes',checks:copy}),/Missing exclusion evidence/);}
});
test('unknown retains its weight and cannot become an invented exclusion',()=>{
 const checks=all();checks['S1.configuration']={status:'not_measured'};const r=scoreReference(rubric,categories,{category:'running-shoes',checks});
 assert.equal(r.status,'incomplete');assert.equal(r.finalScore,null);assert.equal(r.criteria.S1.denominator,13);
 for(const id of ['S1.delivery','S1.readability','S1.scope','S2.syntax','S2.entity','S2.offer']){const copy=all();copy[id]=exclude('single_configuration');assert.throws(()=>scoreReference(rubric,categories,{category:'running-shoes',checks:copy}),/Unjustified exclusion/);}
});
