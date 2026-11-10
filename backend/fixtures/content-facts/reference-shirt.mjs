// Source references for the independently adjudicated complete-shirt.html fixture.
// This is a frozen model-shaped extraction, not a score or a live model result.
export function referenceShirtResponse(request) {
    const entries=JSON.parse(request.messages[1].content).observations;
    const facts=[];
    const add=(kind,key,value,scope='product')=>{
        const found=entries.filter(o=>o.scope===scope && o.text===value);
        if (found.length!==1) throw new Error(`Expected exactly one ${scope} sentence: ${value}`);
        facts.push({kind,key,quoteIds:[found[0].id]});
    };
    add('identity','name','Acme Everyday T-shirt');
    for (const value of ['This everyday T-shirt is designed for adult men and women for casual daily wear.','Its soft cotton fabric provides breathable comfort.']) add('function','function',value);
    for (const value of ['Selected configuration: Medium, US sizing, Navy.','Includes one T-shirt.']) add('configuration','configuration',value);
    for (const [key,value] of [['size','Selected size: Medium (US).'],['color','Selected color: Navy.'],['fiber','Fabric composition: 100% cotton.'],['fit','Regular fit through the chest and body.'],['sleeve','Short sleeves and a crew neckline.'],['neckline','Short sleeves and a crew neckline.'],['fabric-weight','Fabric weight: 180 gsm.'],['garment-measurements','Garment measurements for selected Medium: chest 100 cm, length 70 cm.'],['origin','Made in Portugal.'],['care','Machine wash cold with like colors.']]) add('attribute',key,value);
    add('context','price','This product costs USD 25.00.');
    add('context','availability','This product is in stock.');
    for (const value of ['We ship to the United States.','Shipping is free on this order.','Delivery takes 3 to 5 business days.']) add('policy','shipping',value,'shipping');
    for (const value of ['Unused and unworn items may be returned within 30 days in their original packaging.','The customer pays return shipping.','Refunds go to the original payment method.']) add('policy','returns',value,'returns');
    add('decision','shirt-use','This everyday T-shirt is designed for adult men and women for casual daily wear.');
    add('decision','shirt-fit','Regular fit through the chest and body.');
    for (const value of ['Measure your chest in cm and compare with the garment chart.','Choose Medium for a 100 cm chest garment measurement, allowing room for your fit preference.']) add('decision','shirt-selection',value);
    for (const [key,value] of [['price','This product costs USD 25.00.'],['price','Selected Medium Navy T-shirt: USD 25.00, in stock.'],['availability','This product is in stock.'],['availability','Selected Medium Navy T-shirt: USD 25.00, in stock.']]) add('repeated',key,value);
    return {facts,inspections:[{kind:'decision',key:'shirt-limits',scope:'product',status:'absent'},{kind:'claim',key:'claim',scope:'product',status:'absent'}]};
}
