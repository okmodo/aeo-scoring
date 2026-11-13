import categories from '../config/categories.v1.2.json' with { type: 'json' };

const ids = ['C1.identity','C1.explanation','C1.configuration','C2.essential','C2.supporting','C3.price','C3.availability','C3.shipping','C3.returns','C4.intended-use','C4.compatibility','C4.limitations','C4.selection','C5.consistency','C5.claim-support'];
const unknown = reason => ({status:'not_measured', reason});
const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const unit = /(?:\b|\d)(?:mm|cm|inches|inch|in|kg|lbs?|oz|g|lit(?:er|re)s?|gsm|g\/m[²2]|newtons?|n)\b/i;
const negative = /\b(?:no|not|never|without|neither|does not|isn't|is not|cannot|can't)\b/i;
const generic = /^(?:unknown|various|assorted|n\/a|see (?:details|description)|high quality|premium|comfortable|yes|available)$/i;
const usable = s => typeof s === 'string' && s.trim().length > 1 && !generic.test(s.trim());
const selected = /\b(?:selected|this (?:product|item|shoe|shirt|pack)|one size|single configuration)\b/i;
const market = /\b(?:US|UK|EU|AU|men's|women's|unisex|adult)\b/i;
const pricePattern = /(?:\b(USD|EUR|GBP|CAD|AUD)\s*|([$£€]))\s*(\d+(?:\.\d{1,2})?)|\b(\d+(?:\.\d{1,2})?)\s*(USD|EUR|GBP|CAD|AUD)\b/i;
const materialClaim = /\b(?:certif(?:ied|ication)|approv(?:ed|al)|clinically|medical|health|safety|safe(?:ty)?|non.toxic|hypoallergenic|waterproof|water.resistant|recycl(?:ed|able)|organic|carbon.neutral|sustainab(?:le|ility)|biodegradable|UV protection|\d+(?:\.\d+)?\s*%\s*(?:more|less|reduction|improv)|\d+(?:\.\d+)?\s*(?:hours?|days?)\s+(?:of|for)\s+(?:protection|performance))\b/i;
const positiveCondition = /\b(?:waterproof|water.resistant|impact protection|surface restriction|certified for|safety rated|special (?:fabric )?treatment|treated fabric|dry clean only|wash only|laptop (?:compartment|sleeve|pocket))\b/i;

export function assessContentFacts(snapshot, extracted, validatedFacts) {
    const dto = validatedFacts || {};
    const observations = new Map((dto.observations || []).map(o => [o.id,o]));
    const facts = Array.isArray(dto.facts) ? dto.facts.filter(f=>f.validity==='plausible') : [];
    const category = categories.categories.find(c => c.id === dto.category) || null;
    const coverage = dto.coverage || {};
    const productTruncated = Array.isArray(coverage.truncatedScopes) ? coverage.truncatedScopes.includes('product') : coverage.truncated === true;
    const complete = coverage.productComplete === true && !productTruncated && !coverage.unsafeInstructions;
    const find = (kind,key) => facts.filter(f => f.kind === kind && f.key === key && usable(f.value));
    const obs = f => (f?.quoteIds || []).map(id => observations.get(id)).filter(Boolean);
    const context = f => f?.value || '';
    const productText = [...observations.values()].filter(o=>o.scope==='product').map(o=>o.text).join(' ');
    const ev = f => { const o = obs(f)[0]; return {url: o?.url || (o?.scope === 'shipping' || o?.scope === 'returns' ? snapshot?.policies?.[o.scope]?.url : snapshot?.url), location:o?.location || 'inspected product content', excerpt:(o?.text || 'Inspected complete product content.').slice(0,500)}; };
    const firstProductObservation=[...observations.values()].find(o=>o.scope==='product');
    const scopeEvidence=()=>ev(firstProductObservation ? {quoteIds:[firstProductObservation.id]} : null);
    const measured = (fraction,f,extra={}) => ({status:'measured',fraction,...ev(f),...extra});
    const inspectedAbsent = (kind,key,scope='product') => (dto.inspections || []).some(i=>i.kind===kind && i.key===key && i.scope===scope && i.status==='absent');
    const missing = (label, canConclude=false) => canConclude ? measured(0,null,{excerpt:`Complete inspection found no ${label}.`}) : unknown(`Incomplete inspection cannot establish whether ${label} is absent.`);
    const findings = Object.fromEntries(ids.map(id => [id,unknown('The evidence does not establish this assessment.')]));
    const pick = (kind,key) => find(kind,key)[0];
    const name = pick('identity','name');
    if (name) findings['C1.identity'] = measured(name.value.trim().split(/\s+/).length >= 3 ? 1 : 0.5,name);
    else findings['C1.identity'] = missing('specific product identity',complete && inspectedAbsent('identity','name'));
    const fn = pick('function','function');
    const fnText=find('function','function').map(context).join(' ');
    if (fn && !negative.test(fnText)) findings['C1.explanation'] = measured(/\b(?:designed|built|made|ideal|used) for\b/i.test(fnText) && /\b(?:features?|provides?|helps?|keeps?|holds?|protects?|carries?|offers?|is (?:a|an))\b/i.test(fnText) ? 1 : 0.5,fn);
    else findings['C1.explanation'] = fn ? unknown('The product explanation has ambiguous or negative context.') : missing('product explanation',complete && inspectedAbsent('function','function'));
    const config = pick('configuration','configuration');
    const configText=find('configuration','configuration').map(context).join(' ');
    if (config && !negative.test(configText)) findings['C1.configuration'] = measured(selected.test(configText) && /\b(?:includes?|included|comes with|contains?)\b/i.test(configText) ? 1 : 0.5,config);
    else findings['C1.configuration'] = config ? unknown('Configuration context is ambiguous.') : missing('configuration and included items',complete && inspectedAbsent('configuration','configuration'));
    const attrScore = (id, text) => {
        const t = text.trim();
        // A pointer to a guide or details is not evidence of the underlying value.
        if (/^(?:see|refer to|consult|check|view|visit|read)\b/i.test(t)) return null;
        const vague=/\b(?:many|multiple|various|assorted|premium|high.quality|lightweight|heavyweight|variety of|several)\b/i;
        const quantity=/\d+(?:\.\d+)?/;
        const labelValue = label => {
            const m=t.match(new RegExp(`\\b(?:${label})\\s*[:=]\\s*([^.;]+)`, 'i'));
            return m?.[1]?.trim();
        };
        switch(id) {
        case 'size': {
            const value=/\b(?:size\b\s*[:=-]?\s*(?:xxs|xs|small|medium|large|xl|xxl|xxxl|[sml]|\d+(?:\.\d+)?)\b|selected\s+(?:xxs|xs|small|medium|large|xl|xxl|xxxl|[sml])\b)/i.test(t);
            if (!value) return vague.test(t) ? 0 : null;
            return selected.test(t) && market.test(t) ? 1 : 0.5;
        }
        case 'color': {
            const value=labelValue('colou?r') || t.match(/\bselected\s+(black|white|red|blue|navy|green|yellow|grey|gray|brown|pink|orange|purple)\b/i)?.[1];
            if (!value || /^(?:many|multiple|various|assorted|several|colors?|colours?)\b/i.test(value)) return vague.test(t) ? 0 : null;
            return selected.test(t) ? 1 : 0.5;
        }
        case 'fiber': {
            const names=/\b(?:cotton|polyester|wool|linen|nylon|elastane|spandex|rayon|viscose|acrylic|silk|hemp|modal)\b/i;
            if (!names.test(t)) return /\b(?:blend|fiber|fibre|fabric|composition)\b/i.test(t) && !quantity.test(t) ? 0 : null;
            const p=[...t.matchAll(/(\d+(?:\.\d+)?)\s*%\s*(?:organic\s+)?(?:cotton|polyester|wool|linen|nylon|elastane|spandex|rayon|viscose|acrylic|silk|hemp|modal)\b/gi)].map(m=>Number(m[1]));
            return p.length && Math.abs(p.reduce((a,b)=>a+b,0)-100)<0.01 ? 1 : 0.5;
        }
        case 'weight': {
            if (!quantity.test(t)) return /\b(?:lightweight|heavyweight|light|heavy)\b/i.test(t) ? 0 : null;
            if (!/\b(?:weight|weighs?)\b/i.test(t) && !/\d\s*(?:kg|g|lbs?|oz)\b/i.test(t)) return null;
            return unit.test(t) && (category.id !== 'running-shoes' || /\b(?:per shoe|per pair|each shoe)\b/i.test(t) && /\bsize\s*\w+/i.test(t)) ? 1 : 0.5;
        }
        case 'capacity': return !quantity.test(t) ? (vague.test(t) ? 0 : null) : /\b\d+(?:\.\d+)?\s*(?:l|lit(?:er|re)s?)\b/i.test(t) ? 1 : 0.5;
        case 'dimensions': return !quantity.test(t) ? (vague.test(t) ? 0 : null) : (/(?:\d+(?:\.\d+)?\s*(?:x|×)\s*){2}\d+(?:\.\d+)?/i.test(t) || /\bheight\b/i.test(t) && /\bwidth\b/i.test(t) && /\bdepth\b/i.test(t)) && unit.test(t) && (category.id !== 'casual-daypacks' || /\b(?:external|exterior|outside)\b/i.test(t)) ? 1 : 0.5;
        case 'drop': case 'buoyancy': return !quantity.test(t) ? (vague.test(t) ? 0 : null) : unit.test(t) ? 1 : 0.5;
        case 'fabric-weight': return !quantity.test(t) ? (vague.test(t) ? 0 : null) : /\d+(?:\.\d+)?\s*(?:gsm|g\/m[²2])/i.test(t) ? 1 : 0.5;
        case 'garment-measurements': return !quantity.test(t) ? null : /\bchest\b/i.test(t) && /\blength\b/i.test(t) && unit.test(t) && /\b(?:size|selected)\s*[:\-]?\s*\w+/i.test(t) ? 1 : 0.5;
        case 'laptop-size': return !quantity.test(t) ? null : unit.test(t) && /\b(?:diagonal|screen|measur)/i.test(t) ? 1 : 0.5;
        case 'care': return /\b(?:machine wash|hand wash|wash (?:cold|warm|in)|wipe clean|spot clean|rinse|clean with)\b/i.test(t) ? 1 : null;
        case 'material': case 'upper': case 'outsole': {
            const value=labelValue(id==='material' ? 'material|fabric|shell|body' : id);
            if (value) return /^(?:(?:premium|high.quality|various|assorted)\s+)?(?:materials?|fabric)?[.!\s]*$|^(?:unknown)\b/i.test(value) ? 0 : /^(?:see|refer to|consult|check|view|visit|read)\b/i.test(value) ? null : 1;
            if (/\b(?:nylon|polyester|cotton|leather|foam|neoprene|dyneema)\b/i.test(t)) return 1;
            return vague.test(t) && /\b(?:materials?|fabric|upper|outsole)\b/i.test(t) ? 0 : null;
        }
        default: {
            const patterns = {
                width:/\b(?:regular|standard|wide|narrow)\s+width\b|\bwidth\s*[:=-]\s*(?:regular|standard|wide|narrow|[a-e]{1,2})\b/i, surface:/\b(?:road|trail|track|pavement)\b/i,
                fit:/\b(?:regular|relaxed|slim|loose|fitted|adjustable)\s+fit\b|\bfit\s*[:=-]\s*(?:regular|relaxed|slim|loose|fitted|adjustable)\b/i, sleeve:/\b(?:short|long)[ -]sleeves?\b|\bsleeveless\b/i, neckline:/\b(?:crew|v|scoop|round)[ -]?(?:neck|neckline)\b/i,
                closure:/\b(?:zip(?:per)?|buttons?|buckle|snaps?|drawstring)\b/i, carry:/\b(?:adjustable|padded|removable|shoulder|crossbody|top)\s+(?:straps?|handles?)\b/i,
                compartments:/\b(?:main|interior|exterior|zippered|zip)\s+(?:pockets?|compartments?)\b/i, origin:/\b(?:made|manufactured) in\s+[a-z][a-z -]+|\borigin\s*[:=-]\s*[a-z][a-z -]+/i,
                approval:/\b(?:approved|approval|certified|certification|USCG|coast guard|ISO)\b/i, features:/\b(?:reflective|adjustable|pockets?|harness|straps?)\b/i
            };
            if (patterns[id]?.test(t)) return 1;
            return vague.test(t) ? 0 : null;
        }
        }
    };
    if (category) for (const [pool,attrs] of [['essential',category.essentialAttributes],['supporting',category.supportingAttributes]]) {
        const entries = attrs.map(a => {
            const fs = facts.filter(f=>f.kind==='attribute' && f.key===a.id && typeof f.value==='string' && f.value.trim()), f=fs[0];
            if (!f) return {id:a.id,...missing(a.label,complete && inspectedAbsent('attribute',a.id))};
            const positive=fs.filter(x=>!negative.test(context(x)));
            if (!positive.length) return {id:a.id,...unknown('The attribute appears in negative or ambiguous context.'),...ev(f)};
            const best=positive.map(x=>({f:x,score:attrScore(a.id,context(x))})).sort((a,b)=>(b.score ?? -1)-(a.score ?? -1))[0];
            return best.score === null ? {id:a.id,...unknown('The proposed text does not establish a specific attribute value.'),...ev(best.f)} : {id:a.id,...measured(best.score,best.f)};
        });
        const first=entries.find(e=>e.url);
        findings[`C2.${pool}`] = entries.some(e=>e.status !== 'measured') ? {...unknown('At least one attribute could not be assessed.'),attributes:entries,...(first ? {url:first.url,location:first.location,excerpt:first.excerpt}: {})} : {...measured(entries.reduce((n,e)=>n+e.fraction,0)/entries.length,null),attributes:entries,...(first ? {url:first.url,location:first.location,excerpt:first.excerpt}: {})};
    }
    const priceF = pick('context','price'), stockF = pick('context','availability'), variantF = pick('context','variant');
    const priceText = priceF && context(priceF);
    const candidate = (dto.observedFacts?.priceCandidates || extracted?.productHtml?.priceCandidates || []).filter(p=>p.role==='current');
    const priceMatches = priceText ? [...priceText.matchAll(new RegExp(pricePattern.source, 'gi'))] : [];
    const priceMatch = candidate.length === 1 ? priceMatches.find(m => Number(m[3] || m[4]) === candidate[0].amount) : priceMatches.length === 1 ? priceMatches[0] : null;
    let price = priceMatch && {amount:Number(priceMatch[3] || priceMatch[4]),currency:(priceMatch[1] || priceMatch[5] || ({'$':null,'£':'GBP','€':'EUR'}[priceMatch[2]]) || null),selectedScope:selected.test(priceText) || extracted?.productHtml?.singleConfiguration === true};
    if (candidate.length === 1 && price && candidate[0].amount !== price.amount) price = null;
    if (priceF && price && !negative.test(priceText)) findings['C3.price']=measured(price.currency && price.selectedScope && !/\b(?:from|starting at|installments?|subscription|members? only)\b/i.test(priceText) ? 1 : 0.5,priceF);
    else findings['C3.price']=priceF ? unknown('Price, currency, or current price scope is ambiguous.') : missing('price',complete && inspectedAbsent('context','price'));
    const stockText = stockF && context(stockF);
    const stock = stockText && (!/\b(?:not|never|no longer)\s+(?:out of stock|sold out)\b/i.test(stockText) && /\b(?:not\s+in stock|out of stock|sold out)\b/i.test(stockText) ? 'OutOfStock' : /\bpre.?order\b/i.test(stockText) && !negative.test(stockText) ? 'PreOrder' : /\bin stock\b/i.test(stockText) && !negative.test(stockText) ? 'InStock' : null);
    const stockScope = Boolean(stockText && (selected.test(stockText) || extracted?.productHtml?.singleConfiguration === true));
    if (stock) findings['C3.availability']=measured(stockScope ? 1 : 0.5,stockF);
    else findings['C3.availability']=stockF ? unknown('Availability wording is ambiguous.') : missing('availability',complete && inspectedAbsent('context','availability'));
    for (const kind of ['shipping','returns']) {
        const fs=find('policy',kind), t=fs.map(context).join(' '), policy=snapshot?.policies?.[kind];
        const policyComplete = policy?.state === 'read' && (coverage.policies?.[kind] === 'read' || coverage.policies?.[kind] === true || coverage.policies?.[kind]?.complete === true) && !(coverage.truncatedScopes || []).includes(kind) && !(coverage.uninterpretedScopes || []).includes(kind) && !(coverage.truncated === true && !Array.isArray(coverage.truncatedScopes));
        // An empty or missing link list does not prove discovery was complete.
        const canConclude = complete && policyComplete;
        const terms = kind==='shipping' ? [/\b(?:ship|ships|shipping|deliver|delivery)\s+(?:to|within)\b/i,/\b(?:free shipping|shipping (?:cost|fee|rate)|calculated at checkout|shipping is free)\b/i,/\b(?:delivery|deliver(?:ed|s)?|arriv(?:al|es?))[^.]{0,60}\b\d+\s*(?:(?:to|-|–)\s*\d+\s*)?(?:business )?days?\b/i] : [/\b(?:unused|unworn|unopened|original condition|eligible items?)\b/i,/\b(?:within|up to)\s*\d+\s*days?\b/i,/\b(?:final sale|original packaging|return shipping|refund(?:ed|s)? (?:to|go)|restocking fee)\b/i];
        const n=terms.filter(re=>re.test(t)).length;
        const policyTerms=terms.map((re,index)=>({term:index,found:re.test(t),evidence:fs.filter(f=>re.test(context(f))).map(ev)}));
        if (n===3) findings[`C3.${kind}`]=measured(1,fs[0],{policyTerms});
        else if (n && canConclude) findings[`C3.${kind}`]=measured(0.5,fs[0],{policyTerms});
        else if (n) findings[`C3.${kind}`]=unknown(`The linked ${kind} policy has not been fully inspected.`);
        else findings[`C3.${kind}`]=missing(`${kind} terms`,canConclude && fs.length === 0 && inspectedAbsent('policy',kind,'product') && inspectedAbsent('policy',kind,kind));
    }
    if (category) for (const sub of ['C4.intended-use','C4.compatibility','C4.limitations','C4.selection']) {
        const qs=category.decisionSupport.filter(q=>q.subcheckId===sub);
        const conditions=[];
        const entries=qs.map(q=>{
            if (q.applicability==='conditional') {
                const condition=q.id==='pack-fit' ? /\blaptop (?:compartment|sleeve|pocket)\b/i : q.id==='shirt-limits' ? /\b(?:special (?:fabric )?treatment|treated fabric|dry clean only|wash only)\b/i : positiveCondition;
                const clauses=productText.split(/[.;!\n]+|\bbut\b/i);
                const triggered=clauses.some(clause=>condition.test(clause) && !/\b(?:no|not|without|never|does not|isn't|is not)\b[^,;]{0,45}$/i.test(clause.slice(0,clause.search(condition))));
                if (!triggered && complete && inspectedAbsent('decision',q.id)) { conditions.push({questionId:q.id,condition:q.condition,status:'absent',evidence:'Complete product content inspected.',location:'product content',method:'raw'}); return {questionId:q.id,status:'not_applicable',reason:'The conditional trigger was absent in complete product content.',...ev(null)}; }
                if (!triggered) return {questionId:q.id,...unknown('The conditional trigger cannot be excluded without complete inspection.')};
            }
            const f=pick('decision',q.id);
            if (!f) return {questionId:q.id,...missing(q.question,complete && inspectedAbsent('decision',q.id))};
            const decisionFacts=find('decision',q.id);
            const t=decisionFacts.filter(x=>q.id!=='shirt-fit' || /\b(?:fit|garment|shirt|chest|body|torso|waist)\b/i.test(x.value)).map(context).join(' '); let score=0.5;
            if (sub!=='C4.limitations' && negative.test(t)) return {questionId:q.id,...unknown('The guidance has negative or ambiguous scope.'),...ev(f)};
            if (sub==='C4.intended-use') score=/\b(?:men|women|adult|child|kids|runners?|paddlers?|commuters?|students?|travelers?|shoppers?|users?)\b/i.test(t) && /\b(?:for|use|wear|running|paddling|travel|commut)/i.test(t) ? 1 : 0.5;
            if (sub==='C4.compatibility') score=q.id==='shirt-fit' ? /\b(?:close|loose|straight|roomy|room for|fitted|snug|tapered)\b/i.test(t) ? 1 : 0.5 : /\b(?:measure|compare|adjust|around|across|chest|torso|waist|length|width)\b/i.test(t) ? 1 : 0.5;
            if (sub==='C4.limitations') score=/\b(?:not (?:suitable|intended|designed|rated|waterproof)|only (?:suitable|intended|designed|rated)|do not|must not|limit(?:ed)? to|except)\b/i.test(t) ? 1 : 0.5;
            if (sub==='C4.selection') score=/\b(?:measure|compare|choose|select)\b/i.test(t) && (/\b(?:chest|waist|body|foot|feet|capacity|carrying|fit preference)\b/i.test(t)) && (unit.test(t) || /\b(?:fit preference|capacity|carrying need)\b/i.test(t)) ? 1 : 0.5;
            // A recommendation to consult an unavailable chart is useful but
            // does not itself relate an offered shoe size to a measurement.
            if (q.id==='running-selection' && score===1 && !/\b(?:size|width)\s*[:#-]?\s*[\w.-]+[^.!?]{0,100}\b\d+(?:\.\d+)?\s*(?:in(?:ches)?|cm|mm)\b|\b\d+(?:\.\d+)?\s*(?:in(?:ches)?|cm|mm)\b[^.!?]{0,100}\b(?:size|width)\s*[:#-]?\s*[\w.-]+/i.test(t)) score=0.5;
            return {questionId:q.id,...measured(score,f)};
        });
        const applicable=entries.filter(e=>e.status==='measured');
        if (entries.some(e=>e.status==='not_measured')) findings[sub]={...unknown('A category question or its condition could not be assessed.'),questions:entries};
        else if (!applicable.length && entries.length) findings[sub]={status:'not_applicable',rule:'category_conditions_absent',justification:'All conditional category questions were inspected and their conditions were absent.',conditions,questions:entries,...scopeEvidence()};
        else if (applicable.length) findings[sub]={...measured(applicable.reduce((n,e)=>n+e.fraction,0)/applicable.length,null),questions:entries,url:applicable[0].url,location:applicable[0].location,excerpt:applicable[0].excerpt};
    }
    const repeated=facts.filter(f=>f.kind==='repeated');
    const groups=new Map();
    for (const f of repeated) {const list=groups.get(f.key)||[];list.push(f);groups.set(f.key,list);}
    const comparisonValue=(key,value)=>{
        const t=norm(value);
        if (key==='price') {const m=t.match(pricePattern), currency=m && (m[1] || m[5] || ({'£':'GBP','€':'EUR'}[m[2]]));return m && currency ? `${Number(m[3] || m[4])}:${currency.toUpperCase()}` : null;}
        if (key==='availability') return /\b(?:not in stock|out of stock|sold out)\b/.test(t) ? 'out' : /\bin stock\b/.test(t) && !negative.test(t) ? 'in' : /\bpre.?order\b/.test(t) && !negative.test(t) ? 'preorder' : null;
        if (key==='weight') {const m=t.match(/(\d+(?:\.\d+)?)\s*(kg|g|lbs?|oz)\b/); if (!m) return null; const factor={kg:1000,g:1,lb:453.59237,lbs:453.59237,oz:28.349523125}[m[2]]; return `g:${Math.round(Number(m[1])*factor*100)/100}`;}
        if (key==='size' || key==='color') {const m=t.match(new RegExp(`\\b(?:selected\\s+)?${key}\\s*[:=-]\\s*([a-z0-9-]+)`, 'i')); return m?.[1] || null;}
        if (key==='identity' || key==='material') {const m=t.match(new RegExp(`\\b(?:product\\s+)?${key==='identity' ? 'name' : 'material'}\\s*[:=-]\\s*([^.;]+)`, 'i'));return m?.[1].trim() || null;}
        return null;
    };
    const scopeParts=value=>{
        const t=norm(value), size=t.match(/\b(?:size)\s*[:=-]?\s*(xxs|xs|small|medium|large|xl|xxl|\d+(?:\.\d+)?)(?:\b|$)/i)?.[1];
        const market=t.match(/\b(usd|eur|gbp|cad|aud|us market|uk market|eu market)\b/i)?.[1];
        return {size,market};
    };
    const comparisons=[];
    for (const [key,allFacts] of groups) {
        const allCandidates=dto.observedFacts?.priceCandidates || extracted?.productHtml?.priceCandidates || [];
        const previous=key==='price' ? allCandidates.filter(p=>p.role==='previous').map(p=>Number(p.amount)) : [];
        const fs=allFacts.filter(f=>{if (key!=='price') return true;const m=f.value.match(pricePattern);return !m || !previous.includes(Number(m[3] || m[4]));});
        const sourceCount=new Set(fs.flatMap(f=>obs(f).map(o=>o.id))).size;
        if (sourceCount<2) continue;
        const scope=fs.map(f=>scopeParts(f.value));
        const sameDimension=k=>new Set(scope.map(x=>x[k]).filter(Boolean)).size<=1;
        const explicitScope=fs.every(f=>f.context && ['variant','market','conditions'].every(k=>typeof f.context[k]==='string' && f.context[k].trim() && f.value.includes(f.context[k])));
        const sameContext=['variant','market','conditions'].every(k=>new Set(fs.map(f=>norm(f.context?.[k]))).size===1);
        const unqualified=fs.every(f=>!/\b(?:members? only|subscriber|subscription|coupon|code|with purchase|minimum order|from|starting at|previous(?:ly)?|original(?:ly)?|was|compare at|before|per month|installments?|excluding|outside|only in|only for|in (?:the )?(?:US|UK|EU|Canada|Australia))\b/i.test(f.value));
        const pageScope=extracted?.productHtml?.singleConfiguration === true && unqualified && fs.every(f=>!f.context || Object.values(f.context).every(v=>v===null));
        if (!(explicitScope && sameContext || pageScope) || !sameDimension('size') || !sameDimension('market')) continue;
        const values=fs.map(f=>comparisonValue(key,f.value));
        if (values.some(v=>!v)) continue;
        const unique=[...new Set(values)];
        comparisons.push({field:key,values:unique,fraction:unique.length>1?0:1,evidence:fs.flatMap(f=>obs(f).map(o=>({url:o.url||snapshot?.url,location:o.location,excerpt:o.text.slice(0,500)})))});
    }
    if (comparisons.length) {
        const groupFor={identity:'identity',price:'commercial',availability:'commercial',weight:'physical',color:'physical',size:'physical',material:'physical',suitability:'suitability'};
        const grouped=new Map();
        for (const c of comparisons) {const key=groupFor[c.field]; const list=grouped.get(key)||[]; list.push(c.fraction); grouped.set(key,list);}
        const scores=[...grouped.values()].map(values=>Math.min(...values));
        findings['C5.consistency']=measured(scores.reduce((n,v)=>n+v,0)/scores.length,repeated[0],{comparisons});
    }
    else findings['C5.consistency']=unknown('Comparable shopper-visible facts with the same product and configuration were not established.');
    const claims=find('claim','claim').filter(f=>materialClaim.test(f.value) && !/\b(?:not|no|without)\s+(?:certified|waterproof|water.resistant|recycled|organic)\b/i.test(context(f)));
    if (claims.length && !complete) findings['C5.claim-support']=unknown('Incomplete product inspection cannot establish support for all material claims.');
    else if (claims.length) {
        const quals=find('qualification','qualification');
        const assessed=claims.map(f=>{
            const topics = [/\bwaterproof\b/i,/\bwater.resistan(?:t|ce)\b/i,/\b(?:certif(?:ied|ication)|approv(?:ed|al))\b/i,/\b(?:recycl(?:ed|able)|organic|sustainab(?:le|ility)|carbon.neutral|biodegradable)\b/i,/\b(?:health|medical|non.toxic|hypoallergenic)\b/i,/\b(?:safety|safe)\b/i,/\bUV protection\b/i];
            const matching=topics.filter(re=>re.test(f.value));
            const productType=/\b(?:shoe|shoes|vest|shirt|backpack|daypack|bag|jacket|pfd)\b/i;
            const subject=norm(f.value).match(productType)?.[0];
            const relevant=quals.filter(q=>{const other=norm(q.value).match(productType)?.[0];return matching.some(re=>re.test(q.value)) && norm(q.value)!==norm(f.value) && !(subject && other && subject!==other);});
            const support=relevant.some(q=>/\b(?:ISO|ASTM|ANSI|USCG|EN)\s*[\w.-]*\d[\w.-]*\b/i.test(q.value) && /\b(?:tested|certified|approved|rated|meets?)\b/i.test(q.value) || /\b(?:limited to|only (?:in|for|when|up to)|up to \d|except (?:when|for)|not (?:suitable|designed|intended) for)\b/i.test(q.value));
            return {fraction:support?1:0,...ev(f),support:relevant.map(ev)};
        });
        const qualificationInspected=(dto.inspections || []).some(i=>i.kind==='qualification' && i.key==='qualification' && i.scope==='product' && i.status!=='unknown');
        findings['C5.claim-support']=assessed.some(c=>c.fraction===0) && !qualificationInspected ? {...unknown('The inspection did not establish whether support or qualification exists.'),claims:assessed} : measured(assessed.reduce((n,c)=>n+c.fraction,0)/assessed.length,claims[0],{claims:assessed});
    } else if (complete && inspectedAbsent('claim','claim') && !materialClaim.test(productText)) findings['C5.claim-support']={status:'not_applicable',rule:'no_material_claims',justification:'Complete product content contained no identified material claims requiring substantiation.',...scopeEvidence()};
    const controls = dto.observedFacts?.selectedControls || [];
    const dimensions = controls.filter(c => /^(?:size|colou?r|material|pattern)$/i.test(c.name || '') && typeof c.value === 'string' && c.value.trim() && c.location);
    // Control values can be opaque IDs; only expose values corroborated by
    // a source-grounded selected-variant observation.
    const variantText = find('context','variant').map(context).join(' ');
    const visibleValue = value => {
        const escaped = value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(variantText);
    };
    const keys = dimensions.map(c => c.name.toLowerCase().replace('colour','color'));
    const variant = dimensions.length && new Set(keys).size === keys.length && dimensions.every(c => c.value.length <= 100 && !/[<>\p{Cc}\p{Cf}]/u.test(c.value) && visibleValue(c.value)) ? dimensions.map((c,i) => `${keys[i]}: ${c.value.trim()}`).join(', ').slice(0,160) : null;
    return {category:category?.id || null,findings,productName:name?.value || null,variant,currency:price?.currency || null,facts:{price:price || null,availability:stock || null,availabilityScope:stock ? stockScope : null,configuration:variantF?.value || config?.value || null}};
}
