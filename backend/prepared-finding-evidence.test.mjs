import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePreparedReferences as resolve} from './prepared-finding-evidence.mjs';
const source = (id,text,extra={}) => ({id,documentId:id,kind:'html',scope:'product',url:'https://example.test',location:id,start:0,end:new TextEncoder().encode(text).length,text,...extra});

test('resolves each reference independently with exact and safe entity/whitespace matches',()=>{
 const sources=[source('s1','Coat &amp; shirt\n 100% cotton. Do not bleach. Size M.'),source('s2','Size L.')];
 const refs=[{sourceId:'s1',quote:'100% cotton.'},{sourceId:'s1',quote:'Coat & shirt 100% cotton.'},{sourceId:'s1',quote:'100% silk.'},{sourceId:'s1',quote:'Do bleach.'},{sourceId:'s1',quote:'Size L.'},{sourceId:'s2',quote:'Size L.'},{sourceId:'missing',quote:'x'}];
 const result=resolve(refs,sources,{allowedSourceIds:['s1']});
 assert.deepEqual(result.evidence.map(x=>[x.referenceIndex,x.quote,x.match]),[[0,'100% cotton.','exact'],[1,'Coat &amp; shirt\n 100% cotton.','normalized']]);
 assert.deepEqual(result.rejections.map(x=>x.reason),['quote_not_found_or_ambiguous','quote_not_found_or_ambiguous','quote_not_found_or_ambiguous','source_not_in_batch','unknown_source']);
});
test('rejects ambiguous normalized anchors, changed numbers or units, and unseen sources',()=>{
 const sources=[source('s1','A &amp; B; A &amp; B; 5 kg'),source('s2','A &amp; B')];
 const r=resolve([{sourceId:'s1',quote:'A & B'},{sourceId:'s1',quote:'5 g'},{sourceId:'s2',quote:'A & B'}],sources,{allowedSourceIds:['s1']});
 assert.equal(r.evidence.length,0); assert.equal(r.rejections.length,3);
});
test('typed scalar field references require an entire prepared JSON document and exact value',()=>{
 const text=JSON.stringify({product:{name:'Coat',weight:5,selected:false,variants:[{size:'M'}]}});
 const sources=[source('s1',text,{kind:'structured_product'}),source('s2','{"x":1}',{kind:'extracted',documentId:'split'}),source('s3','{}',{kind:'extracted',documentId:'split',start:7})];
 const refs=[{sourceId:'s1',fieldPath:['product','name'],value:'Coat'},{sourceId:'s1',fieldPath:['product','weight'],value:5},{sourceId:'s1',fieldPath:['product','selected'],value:false},{sourceId:'s1',fieldPath:['product','variants',0,'size'],value:'L'},{sourceId:'s1',fieldPath:['product','weight'],value:'5'},{sourceId:'s2',fieldPath:['x'],value:1}];
 const r=resolve(refs,sources,{allowedSourceIds:['s1','s2']});
 assert.deepEqual(r.evidence.map(e=>e.quote),['"Coat"','5','false']); assert.equal(r.rejections.length,3);
});

test('mixed synthetic apparel observations retain five supported neighbors and reject five unsupported references',()=>{
 const sources=[
  source('s1','Harbor overshirt. 100% cotton. Machine wash cold.\nSize M. Color: blue &amp; white.'),
  source('s2','Recommended: Summit jacket, 80% wool. Size L.'),
  source('s3','Ships in 3 days.')
 ];
 const observations=[
  {sourceId:'s1',quote:'Harbor overshirt.'},
  {sourceId:'s1',quote:'100% cotton.'},
  {sourceId:'s1',quote:'Machine wash cold.'},
  {sourceId:'s1',quote:'Size M.'},
  {sourceId:'s1',quote:'Color: blue & white.'},
  {sourceId:'s1',quote:'80% wool.'}, // recommendation cited as primary source
  {sourceId:'s3',quote:'Ships in 3 days.'}, // source not in model batch
  {sourceId:'s1',quote:'Size L.'}, // another variant/source
  {sourceId:'s1',quote:'100% linen.'},
  {sourceId:'s1',quote:'Do not machine wash cold.'}
 ];
 const result=resolve(observations,sources,{allowedSourceIds:['s1','s2']});
 assert.deepEqual(result.evidence.map(e=>e.referenceIndex),[0,1,2,3,4]);
 assert.equal(result.evidence[4].quote,'Color: blue &amp; white.');
 assert.deepEqual(result.rejections.map(r=>r.referenceIndex),[5,6,7,8,9]);
 assert.equal(result.rejections[1].reason,'source_not_in_batch');
});

test('reference lists and structured quotes respect existing size limits',()=>{
 const text=JSON.stringify({value:'a'.repeat(1001),small:'ok'});
 const sources=[source('s1',text,{kind:'structured_product'})];
 const many=Array.from({length:17},()=>({sourceId:'s1',quote:'ok'}));
 assert.deepEqual(resolve(many,sources),{evidence:[],rejections:[{reason:'reference_limit'}]});
 const r=resolve([{sourceId:'s1',fieldPath:['value'],value:'a'.repeat(1001)},{sourceId:'s1',fieldPath:['small'],value:'ok'}],sources);
 assert.deepEqual(r.evidence.map(x=>x.referenceIndex),[1]);
 assert.equal(r.rejections[0].reason,'invalid_structured_field');
});
