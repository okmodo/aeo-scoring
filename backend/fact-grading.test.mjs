import test from 'node:test';
import assert from 'node:assert/strict';
import { assessContentFacts } from './fact-grading.mjs';

const base = () => ({version:'1.0.0',category:'basic-tshirts',coverage:{productComplete:true,policies:{shipping:true,returns:true},truncated:false,unsafeInstructions:false},observations:[],facts:[],inspections:[]});
const snapshot = {url:'https://shop.example/shirt',policies:{shipping:{state:'read',url:'https://shop.example/shipping'},returns:{state:'read',url:'https://shop.example/returns'}}};
const extracted = {productHtml:{singleConfiguration:true,links:[]}};
function add(d,kind,key,text,scope='product') {const id=`o${d.observations.length}`;d.observations.push({id,scope,location:`paragraph ${id}`,text});d.facts.push({kind,key,value:text,quoteIds:[id],validity:'plausible'});d.inspections.push({kind,key,scope,status:'observed'});}
function repeat(d,key,value) {
    for (let i=0;i<2;i++) {
        const id=`o${d.observations.length}`, text=`Selected Medium Navy, US market, regular sale: ${key}: ${value}.`;
        d.observations.push({id,scope:'product',location:`paragraph ${id}`,text});
        d.facts.push({kind:'repeated',key,value:text,quoteIds:[id],validity:'plausible',context:{variant:'Medium Navy',market:'US market',conditions:'regular sale'}});
    }
}
function absent(d,kind,key,scope='product') {d.inspections.push({kind,key,scope,status:'absent'});}
function shirt() {
    const d=base();
    add(d,'identity','name','Acme Everyday T-shirt');
    add(d,'function','function','This everyday T-shirt is designed for adult men and women for casual daily wear. Its cotton fabric provides comfort.');
    add(d,'configuration','configuration','Selected configuration: Medium, US sizing, Navy. Includes one T-shirt.');
    for (const [key,text] of Object.entries({size:'Selected size: Medium (US).',fiber:'Fabric composition: 100% cotton.',fit:'Regular fit through the chest and body.',color:'Selected color: Navy.',sleeve:'Short sleeves.',neckline:'Crew neckline.',care:'Machine wash cold with like colors.','fabric-weight':'Fabric weight: 180 gsm.','garment-measurements':'Garment measurements for selected Medium: chest 100 cm, length 70 cm.',origin:'Made in Portugal.'})) add(d,'attribute',key,text);
    add(d,'context','price','This product costs USD 25.00.'); add(d,'context','availability','This product is in stock.');
    add(d,'policy','shipping','We ship to the United States. Shipping is free on this order. Delivery takes 3 to 5 business days.','shipping');
    add(d,'policy','returns','Unused and unworn items may be returned within 30 days in their original packaging. The customer pays return shipping.','returns');
    add(d,'decision','shirt-use','This everyday T-shirt is designed for adult men and women for casual daily wear.');
    add(d,'decision','shirt-fit','Regular fit through the chest and body.');
    absent(d,'decision','shirt-limits');
    add(d,'decision','shirt-selection','Measure your chest in cm and compare with the garment chart. Choose Medium for a 100 cm chest garment measurement, allowing room for your fit preference.');
    repeat(d,'price','USD 25.00');
    absent(d,'claim','claim');
    return d;
}

test('reviewed shirt anchors: ordinary care is full and a fit label is partial decision support',()=>{
    const r=assessContentFacts(snapshot,extracted,shirt());
    for(const id of ['C1.identity','C1.explanation','C1.configuration','C2.essential','C2.supporting','C3.price','C3.availability','C3.shipping','C3.returns','C4.intended-use','C4.selection']) assert.equal(r.findings[id].fraction,1,id);
    assert.equal(r.findings['C4.compatibility'].fraction,0.5);
    assert.equal(r.findings['C4.limitations'].status,'not_applicable');
    assert.equal(r.findings['C5.claim-support'].status,'not_applicable');
    assert.equal(r.facts.price.amount,25);
    assert.equal(r.findings['C2.supporting'].attributes.find(x=>x.id==='care').fraction,1);
});

test('incomplete fiber and measured garment without size get partial; omitted inspection stays unknown',()=>{
    const d=shirt(); d.observations.find(o=>o.text==='Fabric composition: 100% cotton.').text='Fabric composition: 60% cotton blend.'; d.facts.find(f=>f.key==='fiber').value='Fabric composition: 60% cotton blend.';
    d.observations.find(o=>o.text.startsWith('Garment measurements')).text='Chest 100 cm, length 70 cm.'; d.facts.find(f=>f.key==='garment-measurements').value='Chest 100 cm, length 70 cm.';
    d.facts=d.facts.filter(f=>f.key!=='origin'); d.inspections=d.inspections.filter(i=>i.key!=='origin');
    const r=assessContentFacts(snapshot,extracted,d);
    assert.equal(r.findings['C2.essential'].attributes.find(x=>x.id==='fiber').fraction,0.5);
    assert.equal(r.findings['C2.supporting'].attributes.find(x=>x.id==='garment-measurements').fraction,0.5);
    assert.equal(r.findings['C2.supporting'].status,'not_measured');
});

test('documented absence is zero only with complete coverage; a linked uninspected policy is unknown',()=>{
    const d=shirt();d.facts=d.facts.filter(f=>f.key!=='neckline' && f.key!=='shipping');d.inspections=d.inspections.filter(i=>i.key!=='neckline' && i.key!=='shipping');absent(d,'attribute','neckline');absent(d,'policy','shipping');d.coverage.policies.shipping=false;
    const e={productHtml:{singleConfiguration:true,links:[{text:'Shipping',url:'/shipping'}]}};
    let r=assessContentFacts(snapshot,e,d);
    assert.equal(r.findings['C2.essential'].attributes.find(x=>x.id==='neckline').fraction,0);
    assert.equal(r.findings['C3.shipping'].status,'not_measured');
    d.coverage.productComplete=false;r=assessContentFacts(snapshot,e,d);
    assert.equal(r.findings['C2.essential'].attributes.find(x=>x.id==='neckline').status,'not_measured');
    assert.equal(r.findings['C4.limitations'].status,'not_measured');
});

test('negated attribute cannot be mistaken for its positive assertion',()=>{
    const d=shirt();d.observations.find(o=>o.text==='Short sleeves.').text='This shirt does not have short sleeves.'; d.facts.find(f=>f.key==='sleeve').value='This shirt does not have short sleeves.';
    const r=assessContentFacts(snapshot,extracted,d);
    assert.equal(r.findings['C2.essential'].attributes.find(x=>x.id==='sleeve').status,'not_measured');
});

test('contradictory shopper observations affect consistency without reducing attribute completeness',()=>{
    const d=shirt();repeat(d,'color','Navy');repeat(d,'color','Red');
    const r=assessContentFacts(snapshot,extracted,d);
    assert.equal(r.findings['C5.consistency'].comparisons.find(c=>c.field==='color').fraction,0);
    assert.equal(r.findings['C2.essential'].attributes.find(x=>x.id==='color').fraction,1);
});

test('sale price selects the explicitly identified current amount',()=>{
    const d=shirt();const f=d.facts.find(f=>f.kind==='context' && f.key==='price');const o=d.observations.find(o=>o.id===f.quoteIds[0]);o.text='This product: USD 159.00 previously, now USD 99.00.';f.value=o.text;d.observedFacts={priceCandidates:[{amount:159,role:'previous'},{amount:99,role:'current'}]};
    const r=assessContentFacts(snapshot,extracted,d);
    assert.equal(r.facts.price.amount,99);
    assert.equal(r.findings['C3.price'].fraction,1);
});

test('material claims need relevant support and an uninspected support search remains unknown',()=>{
    const d=shirt();d.inspections=d.inspections.filter(i=>i.kind!=='claim');add(d,'claim','claim','This vest is waterproof.');
    let r=assessContentFacts(snapshot,extracted,d);assert.equal(r.findings['C5.claim-support'].status,'not_measured');
    absent(d,'qualification','qualification');r=assessContentFacts(snapshot,extracted,d);assert.equal(r.findings['C5.claim-support'].fraction,0);
    d.inspections=d.inspections.filter(i=>i.kind!=='qualification');add(d,'qualification','qualification','Waterproof fabric tested to ISO 811.');
    r=assessContentFacts(snapshot,extracted,d);assert.equal(r.findings['C5.claim-support'].fraction,1);
});

test('not in stock never becomes an in-stock normalized fact',()=>{
    const d=shirt(); const f=d.facts.find(x=>x.kind==='context' && x.key==='availability'); f.value='This product is not in stock.'; d.observations.find(o=>o.id===f.quoteIds[0]).text=f.value;
    const r=assessContentFacts(snapshot,extracted,d); assert.notEqual(r.facts.availability,'InStock');
});

test('an unrelated sentence cannot upgrade a quoted regular-fit label',()=>{
    const d=shirt(); const f=d.facts.find(x=>x.kind==='decision' && x.key==='shirt-fit'); f.value='Regular fit through the chest and body.'; d.observations.find(o=>o.id===f.quoteIds[0]).text='Regular fit through the chest and body. The storage bag is roomy.';
    assert.equal(assessContentFacts(snapshot,extracted,d).findings['C4.compatibility'].fraction,0.5);
});

test('unrelated testing, even in the same observation, does not support a waterproof claim',()=>{
    const d=shirt();d.inspections=d.inspections.filter(i=>i.kind!=='claim');add(d,'claim','claim','This vest is waterproof.'); const c=d.facts.find(f=>f.kind==='claim');d.observations.find(o=>o.id===c.quoteIds[0]).text='This vest is waterproof. The shoe was tested to ISO 811.';
    d.facts.push({kind:'qualification',key:'qualification',value:'The shoe was tested to ISO 811.',quoteIds:c.quoteIds,validity:'plausible'});d.inspections.push({kind:'qualification',key:'qualification',scope:'product',status:'observed'});
    assert.equal(assessContentFacts(snapshot,extracted,d).findings['C5.claim-support'].fraction,0);
});

test('an omitted material claim cannot yield no-claim exclusion',()=>{
    const d=shirt();d.observations.push({id:'extra',scope:'product',location:'description',text:'The shirt is waterproof.'});
    assert.equal(assessContentFacts(snapshot,extracted,d).findings['C5.claim-support'].status,'not_measured');
});

test('a negative laptop-sleeve statement does not trigger sleeve compatibility',()=>{
    const d=base();d.category='casual-daypacks';d.observations.push({id:'negative',scope:'product',location:'description',text:'This pack has no laptop sleeve.'});absent(d,'decision','pack-fit');
    assert.equal(assessContentFacts(snapshot,extracted,d).findings['C4.compatibility'].status,'not_applicable');
});

test('one observation per value detects a scoped commercial contradiction',()=>{
    const d=base(); const addRepeated=(amount,id)=>{const text=`Selected Medium Navy, US market, regular sale: USD ${amount}.`;d.observations.push({id,scope:'product',location:id,text});d.facts.push({kind:'repeated',key:'price',value:text,quoteIds:[id],validity:'plausible',context:{variant:'Medium Navy',market:'US market',conditions:'regular sale'}});};addRepeated('25.00','a');addRepeated('30.00','b');
    assert.equal(assessContentFacts(snapshot,extracted,d).findings['C5.consistency'].fraction,0);
});

test('different sizes and unknown markets do not establish a contradiction',()=>{
    const d=base();for (const [size,price,id] of [['Small','25','a'],['Large','30','b']]) {const text=`Selected ${size}, US market, regular sale: USD ${price}.`;d.observations.push({id,scope:'product',location:id,text});d.facts.push({kind:'repeated',key:'price',value:text,quoteIds:[id],validity:'plausible',context:{variant:size,market:'US market',conditions:'regular sale'}});}
    assert.equal(assessContentFacts(snapshot,extracted,d).findings['C5.consistency'].status,'not_measured');
    d.facts[1].context.variant='Small';d.facts[1].context.market=null;
    assert.equal(assessContentFacts(snapshot,extracted,d).findings['C5.consistency'].status,'not_measured');
});

test('equivalent numeric prices compare equal',()=>{
    const d=base();for (const [price,id] of [['25','a'],['25.00','b']]) {const text=`Selected Medium, US market, regular sale: USD ${price}.`;d.observations.push({id,scope:'product',location:id,text});d.facts.push({kind:'repeated',key:'price',value:text,quoteIds:[id],validity:'plausible',context:{variant:'Medium',market:'US market',conditions:'regular sale'}});}
    assert.equal(assessContentFacts(snapshot,extracted,d).findings['C5.consistency'].fraction,1);
});

test('a negative waterproof statement does not trigger conditional restrictions',()=>{
    const d=base();d.category='casual-daypacks';d.observations.push({id:'negative',scope:'product',location:'description',text:'This pack is not waterproof.'});absent(d,'decision','pack-limits');
    assert.equal(assessContentFacts(snapshot,extracted,d).findings['C4.limitations'].status,'not_applicable');
});

test('single-configuration page permits unqualified same-currency comparison without inventing a market',()=>{
    const d=base();for (const [price,id] of [['25','a'],['25.00','b']]) {const text=`This product costs USD ${price}.`;d.observations.push({id,scope:'product',location:id,text});d.facts.push({kind:'repeated',key:'price',value:text,quoteIds:[id],validity:'plausible',context:{variant:null,market:null,conditions:null}});}
    assert.equal(assessContentFacts(snapshot,extracted,d).findings['C5.consistency'].fraction,1);
});

test('previous sale price is not a current-price contradiction',()=>{
    const d=base();d.observedFacts={priceCandidates:[{role:'previous',amount:159},{role:'current',amount:99}]};for (const [price,id] of [['159','a'],['99','b']]) {const text=`This product costs USD ${price}.`;d.observations.push({id,scope:'product',location:id,text});d.facts.push({kind:'repeated',key:'price',value:text,quoteIds:[id],validity:'plausible',context:{variant:null,market:null,conditions:null}});}
    assert.equal(assessContentFacts(snapshot,extracted,d).findings['C5.consistency'].status,'not_measured');
});

test('reviewed shirt source passes through literal fact validation and retains the adjudicated content anchors',async()=>{
    const {readFileSync}=await import('node:fs'); const {extract}=await import('./retrieval.mjs'); const {HtmlTestRewriter}=await import('./html-product-test-helper.mjs'); const {buildSemanticRequest}=await import('./semantic-assessment.mjs'); const {buildContentFactsRequest,decodeContentFacts}=await import('./content-facts.mjs');
    const fixture=n=>readFileSync(new URL(`./fixtures/complete-engine/${n}`,import.meta.url),'utf8');
    const snap={url:'https://shop.example/products/everyday-tshirt',observedAt:'2026-11-09T00:00:00.000Z',body:fixture('complete-shirt.html'),htmlLimited:null,...JSON.parse(fixture('support.json'))};
    const html=await extract(snap,{HTMLRewriter:HtmlTestRewriter});const prepared=buildSemanticRequest(snap,html,{category:'basic-tshirts',currency:'USD'});const request=buildContentFactsRequest(prepared);
    const {referenceShirtResponse}=await import('./fixtures/content-facts/reference-shirt.mjs');
    const output=referenceShirtResponse(request);
    assert.equal(output.facts.length,31);
    const validated=decodeContentFacts(prepared,request,output);
    assert.equal(validated.facts.filter(f=>f.validity==='plausible' && f.method!=='literal_pattern').length,31,JSON.stringify(validated.facts.filter(f=>f.validity!=='plausible').map(f=>({kind:f.kind,key:f.key,value:f.value}))));
    assert.deepEqual(validated.facts.filter(f=>f.method==='literal_pattern').map(f=>`${f.kind}.${f.key}`).sort(),['context.availability','context.price']);const result=assessContentFacts(snap,html,validated);
    for(const id of ['C1.identity','C1.explanation','C1.configuration','C2.essential','C2.supporting','C3.price','C3.availability','C3.shipping','C3.returns','C4.intended-use','C4.selection','C5.consistency']) assert.equal(result.findings[id].fraction,1,id);
    const {scoreAudit}=await import('./scoring.mjs');const report=scoreAudit(snap,html,{validatedFacts:validated});
    assert.equal(report.status,'complete',JSON.stringify(report.criteria.flatMap(c=>c.subchecks).filter(c=>c.status==='not_measured').map(c=>({id:c.id,reason:c.reason}))));assert.equal(report.coverage.notMeasured,0);assert.deepEqual(report.score,{total:78.125,structure:20,content:58.125});
    assert.equal(result.findings['C4.compatibility'].fraction,0.5);assert.equal(result.findings['C4.limitations'].status,'not_applicable');assert.equal(result.findings['C5.claim-support'].status,'not_applicable');
});

test('a different product cannot support the same claim topic',()=>{
    const d=shirt();d.inspections=d.inspections.filter(i=>i.kind!=='claim');add(d,'claim','claim','This vest is waterproof.');add(d,'qualification','qualification','The waterproof shoe was tested to ISO 811.');
    assert.equal(assessContentFacts(snapshot,extracted,d).findings['C5.claim-support'].fraction,0);
});

test('attribute anchors distinguish vague weight, numeric weight without a unit, and a complete measurement',()=>{
    const grade=text=>{const d=base();d.category='handbags';add(d,'attribute','weight',text);return assessContentFacts(snapshot,extracted,d).findings['C2.supporting'].attributes.find(a=>a.id==='weight');};
    assert.equal(grade('Lightweight.').fraction,0);
    assert.equal(grade('Weight: 12.').fraction,0.5);
    assert.equal(grade('Weight: 12 g.').fraction,1);
    assert.equal(grade('Weight: 12g.').fraction,1);
    assert.equal(grade('The 12-month warranty applies.').status,'not_measured');
});

test('categorical material, size and color require specific values rather than marketing generalities',()=>{
    const grade=(category,id,text)=>{const d=base();d.category=category;add(d,'attribute',id,text);const result=assessContentFacts(snapshot,extracted,d);return [result.findings['C2.essential'],result.findings['C2.supporting']].flatMap(x=>x.attributes||[]).find(a=>a.id===id);};
    assert.equal(grade('handbags','material','Premium materials.').fraction,0);
    assert.equal(grade('handbags','material','Material: Dyneema.').fraction,1);
    assert.equal(grade('handbags','material','Material: premium Dyneema.').fraction,1);
    assert.equal(grade('basic-tshirts','size','Many sizes available.').fraction,0);
    assert.equal(grade('basic-tshirts','size','Selected size: M (US).').fraction,1);
    assert.equal(grade('basic-tshirts','color','Many colors available.').fraction,0);
    assert.equal(grade('basic-tshirts','color','Selected color: Blue.').fraction,1);
});

test('unknown role proposals cannot count as fiber, price or comparison evidence',()=>{
    const d=shirt();const fiber=d.facts.find(f=>f.kind==='attribute' && f.key==='fiber');fiber.validity='unknown';fiber.value='Save 100% on orders today.';
    d.facts.find(f=>f.kind==='context' && f.key==='price').validity='unknown';d.facts.filter(f=>f.kind==='repeated').forEach(f=>f.validity='unknown');
    const r=assessContentFacts(snapshot,extracted,d);
    assert.equal(r.findings['C2.essential'].attributes.find(a=>a.id==='fiber').status,'not_measured');
    assert.equal(r.findings['C3.price'].status,'not_measured');
    assert.equal(r.findings['C5.consistency'].status,'not_measured');
});

test('fit specificity satisfies the attribute while a label without cut guidance remains partial decision support',()=>{
    const d=shirt();const r=assessContentFacts(snapshot,extracted,d);
    assert.equal(r.findings['C2.essential'].attributes.find(a=>a.id==='fit').fraction,1);
    assert.equal(r.findings['C4.compatibility'].fraction,0.5);
});
