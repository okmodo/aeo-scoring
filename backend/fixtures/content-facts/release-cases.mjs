// Frozen synthetic calibration inputs and pre-model expectations. Expected roles
// identify source sentences, never model scores. Independent review is required.
import { readFileSync } from 'node:fs';
import { buildSemanticRequest } from '../../semantic-assessment.mjs';
import { buildContentFactsRequest } from '../../content-facts.mjs';
import { extract } from '../../retrieval.mjs';
import { HtmlTestRewriter } from '../../html-product-test-helper.mjs';

const definitions = [
    { id:'running-shoes', name:'Acme Road Running Shoes', detail:'Upper: nylon.', role:['attribute','upper'], expected:{'C1.identity':1,'C3.price':1,'C3.availability':1} },
    { id:'casual-daypacks', name:'Acme Everyday Daypack', detail:'Capacity: 20 liters.', role:['attribute','capacity'], expected:{'C1.identity':1,'C3.price':1,'C3.availability':1} },
    { id:'personal-flotation-devices', name:'Acme River Life Vest', detail:'Buoyancy: 15 lbs.', role:['attribute','buoyancy'], expected:{'C1.identity':1,'C3.price':1,'C3.availability':1} },
    { id:'handbags', name:'Acme Leather Handbag', detail:'Material: leather.', role:['attribute','material'], expected:{'C1.identity':1,'C3.price':1,'C3.availability':1} },
];
const categoryEvidence = {
    'running-shoes': {
        attributes: [['size','Selected size: 9 US.'],['width','Width: regular.'],['surface','Road running surface.'],['outsole','Outsole: rubber.'],['color','Selected color: blue.'],['weight','Weight: 10 oz.'],['drop','Heel-to-toe drop: 8 mm.'],['closure','Lace closure.'],['care','Hand wash cold.']],
        decisions: [['running-use','This running shoe is designed for adult road runners.'],['running-fit','Regular fit around the foot with room at the toes.'],['running-selection','Measure your foot in inches and compare with the shoe size chart.']]
    },
    'casual-daypacks': {
        attributes: [['dimensions','Dimensions: 18 x 12 x 6 inches.'],['material','Material: nylon.'],['closure','Zipper closure.'],['color','Selected color: blue.'],['carry','Adjustable shoulder straps.'],['weight','Weight: 12 oz.'],['compartments','Interior pocket.'],['care','Wipe clean.'],['laptop-size','Fits a 13 inch laptop.']],
        decisions: [['pack-use','This daypack is designed for adults carrying everyday items.'],['pack-fit','The laptop sleeve fits a 13 inch laptop.'],['pack-selection','Choose 20 liters for a small daily load.']]
    },
    'personal-flotation-devices': {
        attributes: [['size','Selected size: Medium US.'],['approval','USCG approved.'],['material','Material: nylon.'],['color','Selected color: blue.'],['closure','Buckle closure.'],['weight','Weight: 20 oz.'],['fit','Adjustable fit.'],['care','Rinse with fresh water.'],['features','Adjustable straps.']],
        decisions: [['personal-flotation-devices-intended-use','This life vest is designed for adult paddlers.'],['personal-flotation-devices-compatibility','Adjust the straps for a snug fit around the torso.'],['personal-flotation-devices-selection','Measure your chest and compare it with the vest size chart.']]
    },
    'handbags': {
        attributes: [['dimensions','Dimensions: 10 x 8 x 4 inches.'],['closure','Zipper closure.'],['color','Selected color: blue.'],['carry','Adjustable shoulder strap.'],['compartments','Interior pocket.'],['weight','Weight: 12 oz.'],['care','Wipe clean.'],['origin','Made in Portugal.'],['features','Interior pockets.']],
        decisions: [['handbags-intended-use','This handbag is designed for adults carrying daily essentials.'],['handbags-compatibility','The interior fits a phone measuring 6 inches.'],['handbags-selection','Choose the 10 inch bag for a small daily load.']]
    }
};
// Frozen server outcomes for the cited proposals below, with unknown conditions.
// The review notes record independent source-level disagreements and limitations.
const outcomes = {
    'running-shoes': {'C1.explanation':1,'C2.essential':1,'C2.supporting':0.875,'C4.intended-use':1,'C4.compatibility':1,'C4.selection':0.5},
    'casual-daypacks': {'C1.explanation':1,'C2.essential':11/12,'C2.supporting':7/8,'C4.intended-use':1,'C4.compatibility':0.5,'C4.selection':1},
    'personal-flotation-devices': {'C1.explanation':1,'C2.essential':1,'C2.supporting':1,'C4.intended-use':1,'C4.compatibility':1,'C4.selection':1,'C5.claim-support':0.5},
    'handbags': {'C1.explanation':1,'C2.essential':11/12,'C2.supporting':1,'C4.intended-use':1,'C4.compatibility':1,'C4.selection':1}
};
const commonOutcomes = {'C1.identity':1,'C1.configuration':0.5,'C3.price':1,'C3.availability':1,'C3.shipping':'not_measured','C3.returns':'not_measured','C4.limitations':'not_measured','C5.consistency':'not_measured','C5.claim-support':'not_measured'};
const commonPrice='This product costs USD 25.00.';
const commonStock='This product is in stock.';
function prepareCase(def) {
    const snapshot={url:`https://synthetic.example/${def.id}`,policies:{}};
    const extra=categoryEvidence[def.id];
    const sentences=[def.detail,...extra.attributes.map(([,text])=>text),...extra.decisions.map(([,text])=>text),commonPrice,commonStock];
    const extracted={productHtml:{complete:true,singleConfiguration:true,identity:def.name,blocks:sentences.map((text,i)=>({text,location:`product-${i+1}`})),links:[]}};
    const prepared=buildSemanticRequest(snapshot,extracted,{category:def.id});
    const request=buildContentFactsRequest(prepared);
    return {id:def.id,snapshot,extracted,prepared,request,expected:{
        facts:[{kind:'identity',key:'name',scope:'product',text:def.name},{kind:def.role[0],key:def.role[1],scope:'product',text:def.detail},{kind:'context',key:'price',scope:'product',text:commonPrice},{kind:'context',key:'availability',scope:'product',text:commonStock},...extra.attributes.filter(([key])=>['size','color'].includes(key)).map(([,text])=>({kind:'configuration',key:'configuration',scope:'product',text})),...extra.attributes.map(([key,text])=>({kind:'attribute',key,scope:'product',text})),...extra.decisions.map(([key,text])=>({kind:'decision',key,scope:'product',text})),{kind:'function',key:'function',scope:'product',text:extra.decisions[0][1]},...(def.id==='personal-flotation-devices' ? [{kind:'claim',key:'claim',scope:'product',text:'USCG approved.'}] : [])],
        // Omission or unknown is not an assertion of absence.
        absent:[], unknown:['conditional triggers and claim support'], checks:{...commonOutcomes,...outcomes[def.id]},
        justification:'Source sentences in facts identify each proposed role. Selected size and color are partial configuration evidence. Conditional checks are unknown; missing policy and comparison evidence remains unmeasured. Category pools and question fractions reflect the documented server anchors, not model scores.',
        overall:'incomplete: policies, conditional limitations, consistency or claim support remain unmeasured'
    }};
}
export async function releaseCases() {
    const read=name=>readFileSync(new URL(`../complete-engine/${name}`,import.meta.url),'utf8');
    const snapshot={url:'https://shop.example/products/everyday-tshirt',observedAt:'2026-11-09T00:00:00.000Z',body:read('complete-shirt.html'),htmlLimited:null,...JSON.parse(read('support.json'))};
    const extracted=await extract(snapshot,{HTMLRewriter:HtmlTestRewriter});
    const prepared=buildSemanticRequest(snapshot,extracted,{category:'basic-tshirts',currency:'USD'});
    const shirt={id:'basic-tshirts',snapshot,extracted,prepared,request:buildContentFactsRequest(prepared),expected:{
        reference:'reference-shirt.mjs',absent:['shirt-limits','material_claim'],checks:{total:80,structure:20,content:60},overall:'complete'
    }};
    return [...definitions.map(prepareCase),shirt];
}
