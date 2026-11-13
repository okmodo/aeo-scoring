import categories from '../config/categories.v1.2.json' with { type: 'json' };
export const CONTENT_RULE_VERSION = '1.0.0';
const unknown = (reason = 'The evidence does not establish this assessment.') => ({ status: 'not_measured', reason });
const negated = text => /\b(?:not|no|never|without|neither|doesn.t|isn.t|cannot|can.t)\b/i.test(text);
const safe = text => !/\b(?:ignore (?:all )?(?:previous |prior )?instructions|disregard (?:all )?(?:previous |prior )?instructions|say fit|system prompt|assistant|score (?:this|the)|give (?:full|maximum) (?:credit|points))\b/i.test(text);
export const hasAmbiguousPolicyCue = (kind,text) => (kind === 'shipping' ? /\b(?:ship\w*|deliver\w*|dispatch\w*|freight|transit|orders?|purchases?|exclusions?)\b/i : /\b(?:return\w*|refund\w*|exchange\w*|store credit|final|sales?|orders?|purchases?|exclusions?)\b/i).test(text);
const patterns = {
    size: /\b(?:size|sizes)\s*[:\-]\s*(?:[\w./-]+(?:\s*[,/]\s*[\w./-]+)*)/i,
    width: /\b(?:width\s*[:\-]\s*(?:regular|standard|wide|narrow|[A-E]{1,2})|(?:regular|standard|wide|narrow) width)\b/i,
    surface: /\b(?:road|trail|track|pavement) running\b|\brunning (?:on|surface[: -]+) (?:roads?|trails?|tracks?|pavement)\b/i,
    upper: /\bupper\s*[:\-]\s*(?:[\w-]+\s*){1,4}/i, outsole: /\boutsole\s*[:\-]\s*(?:[\w-]+\s*){1,4}/i,
    color: /\bcolou?r\s*[:\-]\s*[\w-]+/i, capacity: /\b\d+(?:\.\d+)?\s*(?:lit(?:er|re)s?|L)\b/i,
    dimensions: /\b\d+(?:\.\d+)?\s*(?:x|×)\s*\d+(?:\.\d+)?\s*(?:x|×)\s*\d+(?:\.\d+)?\s*(?:in(?:ches)?|cm|mm)\b/i,
    material: /\b(?:material|body|shell|fabric)\s*[:\-]\s*(?:leather|nylon|polyester|cotton|canvas|vinyl|polyurethane|neoprene)\b/i,
    fiber: /\b\d+%\s*(?:organic\s+)?(?:cotton|polyester|wool|linen|rayon|nylon|elastane|spandex)\b/i, fit: /\b(?:slim|relaxed|regular|adjustable) fit\b/i,
    sleeve: /\b(?:(?:short|long)[ -]sleeves?|sleeveless)\b/i, neckline: /\b(?:crew[ -]?neck|v[ -]?neck|scoop[ -]?neck)\b/i,
    closure: /\b(?:zip(?:per)?|buckle|button|snap|drawstring|magnetic) closure\b|\bclosure\s*[:\-]\s*(?:zip(?:per)?|buckle|button|snap|drawstring|magnetic)\b/i,
    carry: /\b(?:adjustable|padded|removable|dual|two) (?:shoulder )?straps?\b|\b(?:top handles?|shoulder strap)\b/i,
    compartments: /\b(?:interior|exterior|main|zippered|zip) (?:pockets?|compartments?)\b/i,
    weight: /\bweight\s*[:\-]\s*\d+(?:\.\d+)?\s*(?:oz|g|kg|lb|lbs)\b/i,
    drop: /\b(?:heel.to.toe )?drop\s*[:\-]\s*\d+(?:\.\d+)?\s*mm\b/i,
    care: /\b(?:hand wash|machine wash|wipe clean|spot clean|rinse (?:with |in )?(?:fresh |cold |warm )?water|clean with (?:a |mild )?[^.]{3,35})\b/i,
    'laptop-size': /\b(?:fits?|holds?) (?:a )?\d+(?:\.\d+)?[ -]?(?:inch|in) laptop\b/i,
    'fabric-weight': /\b\d+\s*(?:gsm|g\/m²)\b/i, 'garment-measurements': /\b(?:chest|length|waist)\s*(?:[:\-]\s*|\s+)\d+(?:\.\d+)?\s*(?:in|cm)\b/i,
    origin: /\b(?:made in|country of origin\s*:)\s*[A-Za-z ]{3,30}\b/i,
    buoyancy: /\b\d+(?:\.\d+)?\s*(?:lbs?|pounds?|newtons?|N)\s*(?:of )?(?:buoyancy|flotation)\b|\b(?:buoyancy|flotation)\s*[:\-]\s*\d+(?:\.\d+)?\s*(?:lbs?|pounds?|newtons?|N)\b/i,
    approval: /\b(?:USCG|U\.S\. Coast Guard|ISO)\s*(?:approved|approval|certified|certification|\d)/i,
    features: /\b(?:reflective (?:trim|panels?)|adjustable straps?|interior pockets?|rescue (?:belt|harness))\b/i,
};
// Literal fallback requires the whole observation to be a carry descriptor.
export function isExplicitCarry(text) {
    return typeof text === 'string' && new RegExp(`^(?:${patterns.carry.source})[.!]?$`, 'i').test(text.trim());
}
export function isExplicitSize(text) {
    if (typeof text !== 'string') return false;
    const value = text.trim().replace(/^selected\s+/i, '').replace(/\s*\((?:US|UK|EU|AU)\)(?=[.!]?$)/i, '').replace(/[.!]$/, '');
    return new RegExp(`^(?:${patterns.size.source})$`, 'i').test(value);
}
function match(blocks, re) { return blocks.find(b => safe(b.text) && !negated(b.text) && re.test(b.text)); }
function evidence(block, fallback, url) { return { url, location: block?.location || 'product region', excerpt: (block?.text || fallback).slice(0, 500) }; }
function measured(fraction, block, fallback, url, extra = {}) { return { status: 'measured', fraction, ...evidence(block, fallback, url), ...extra }; }
function inferCategory(text) {
    if (/\b(?:pfd|personal flotation device|life (?:vest|jacket))\b/i.test(text))
        return 'personal-flotation-devices';
    if (/\b(?:handbag|crossbody bag|shoulder bag|satchel|tote bag)\b/i.test(text))
        return 'handbags';
    if (/\brunning shoes?\b/i.test(text))
        return 'running-shoes';
    if (/\b(?:daypack|everyday backpack|casual backpack)\b/i.test(text))
        return 'casual-daypacks';
    if (/\b(?:t-shirt|tee shirt)\b/i.test(text))
        return 'basic-tshirts';
    return null;
}
export function assessContent(snapshot, extracted, { category = null, product = null } = {}) {
    const html = extracted?.productHtml;
    const url = snapshot?.url;
    const findings = {};
    const ids = ['C1.identity', 'C1.explanation', 'C1.configuration', 'C2.essential', 'C2.supporting', 'C3.price', 'C3.availability', 'C3.shipping', 'C3.returns', 'C4.intended-use', 'C4.compatibility', 'C4.limitations', 'C4.selection', 'C5.consistency', 'C5.claim-support'];
    for (const id of ids)
        findings[id] = unknown();
    if (!html || !Array.isArray(html.blocks))
        return { category: null, findings };
    const blocks = [...html.blocks, ...(html.headings || [])].filter(b => typeof b?.text === 'string' && b.text.trim());
    const complete = html.complete === true && blocks.every(b => safe(b.text));
    const name = typeof html.identity === 'string' ? html.identity : html.identity?.mainH1 || html.identity?.title || null;
    const requested = typeof category === 'string' ? category : category?.id;
    const categoryText = [name, product?.description, product?.category, ...blocks.map(b => b.text)].filter(value => typeof value === 'string').join(' ');
    const nameCandidate = inferCategory(name || '');
    // Use only product-scoped, safe text and associated Product fields. Avoid
    // inferring from comparisons or merchandising copy about other products.
    const descriptions = [product?.description, product?.category, ...blocks.map(b => b.text)]
        .filter(value => typeof value === 'string' && safe(value) && !negated(value) && !/\b(?:other products?|other items?|pair with|complete the look|you may also like|recommended|shop (?:our|for)|compare(?:d)? (?:to|with))\b/i.test(value));
    const fallbackMatches = new Set();
    for (const text of descriptions) {
        // An individual block may mention more than one supported category.
        for (const [id, re] of Object.entries({
            'personal-flotation-devices': /\b(?:pfd|personal flotation device|life (?:vest|jacket))\b/i,
            'handbags': /\b(?:handbag|crossbody bag|shoulder bag|satchel|tote bag)\b/i,
            'running-shoes': /\b(?:running shoes?|(?:road|trail)[ -]running shoes?)\b/i,
            'casual-daypacks': /\b(?:daypack|everyday backpack|casual backpack)\b/i,
            'basic-tshirts': /\b(?:t-shirt|tee shirt|(?:graphic|everyday|casual|short[ -]sleeve) tee)\b/i
        })) if (re.test(text)) fallbackMatches.add(id);
    }
    const candidate = nameCandidate || (fallbackMatches.size === 1 ? [...fallbackMatches][0] : null);
    const exclusions = {
        'running-shoes': /\b(?:medical|orthop(?:edic|aedic)|therapeutic|protective footwear|safety footwear|steel.toe)\b/i,
        'casual-daypacks': /\b(?:medical|oxygen carrier|technical climbing|child carrier|safety equipment)\b/i,
        'basic-tshirts': /\b(?:medical|protective|safety garment|flame.resistant|fire.resistant|high.visibility|specialized performance)\b/i
    };
    const excluded = Boolean(exclusions[candidate]?.test(categoryText));
    const inferred = excluded ? null : candidate;
    const selected = excluded ? null : requested ? categories.categories.find(c => c.id === requested) : categories.categories.find(c => c.id === inferred);
    const categoryId = selected?.id || null;
    const set = (id, fraction, block, fallback, extra) => { findings[id] = measured(fraction, block, fallback, url, extra); };
    const absent = (id, label) => {
        if (complete && !blocks.length)
            set(id, 0, null, `The complete product region contained no product text; ${label} is absent.`);
        else
            findings[id] = unknown(`The product text may describe ${label} in wording this rule cannot interpret.`);
    };
    if (name && safe(name)) {
        const brand = typeof product?.brand === 'string' ? product.brand : product?.brand?.name;
        const specific = brand && name.toLowerCase().includes(brand.toLowerCase()) && name.trim().split(/\s+/).length >= 3;
        set('C1.identity', specific ? 1 : /\w+\s+\w+/.test(name) ? 0.5 : 0, null, `Product heading: ${name}`);
    }
    else
        absent('C1.identity', 'product identity');
    const description = match(blocks, /\b(?:designed for|built for|made for|is (?:a|an) |features? (?:a|an|the|\d)|provides?\s+\w+)/i);
    if (description)
        set('C1.explanation', /\b(?:designed|built|made) for\s+[^.]{5,}/i.test(description.text) && /\b(?:features?|provides?|helps?|keeps?|holds?|protects?|carries?)\b/i.test(description.text) ? 1 : 0.5, description, '', {});
    else
        absent('C1.explanation', 'a product explanation');
    const config = match(blocks, /\b(?:includes?|included|comes with)\s+(?:a |an |one |the )?\w+/i);
    if (config)
        set('C1.configuration', /\b(?:selected|one size|single configuration)\b/i.test(config.text) && /\b(?:includes?|included|comes with)\b/i.test(config.text) ? 1 : 0.5, config, '');
    else
        absent('C1.configuration', 'configuration and included items');
    if (selected && complete)
        for (const [key, attrs] of [['essential', selected.essentialAttributes], ['supporting', selected.supportingAttributes]]) {
            let entries = attrs.map(a => {
                const b = patterns[a.id] && match(blocks, patterns[a.id]);
                let score = b ? 1 : 0;
                if (b && a.id === 'size')
                    score = /\bselected\b/i.test(b.text) && /\b(?:US|UK|EU|AU|women.s|men.s)\b/i.test(b.text) ? 1 : 0.5;
                if (b && a.id === 'color')
                    score = /\bselected\b/i.test(b.text) ? 1 : 0.5;
                if (b && a.id === 'weight')
                    score = categoryId === 'running-shoes' && !(/\b(?:per shoe|per pair)\b/i.test(b.text) && /\bsize\s*\d/i.test(b.text)) ? 0.5 : 1;
                if (b && a.id === 'garment-measurements')
                    score = /\b(?:selected\s+)?size\s*[:\-]?\s*(?:[A-Za-z]+|\d+)\b/i.test(b.text) && /\b(?:chest|waist)\s*[:\-]?\s*\d+(?:\.\d+)?\s*(?:in(?:ches)?|cm)\b/i.test(b.text) && /\blength\s*[:\-]?\s*\d+(?:\.\d+)?\s*(?:in(?:ches)?|cm)\b/i.test(b.text) ? 1 : 0.5;
                if (b && a.id === 'fiber') {
                    const percentages = [...b.text.matchAll(/(\d+(?:\.\d+)?)%\s*(?:organic\s+)?(?:cotton|polyester|wool|linen|rayon|nylon|elastane|spandex)/gi)];
                    score = percentages.reduce((n, m) => n + Number(m[1]), 0) === 100 ? 1 : 0.5;
                }
                const cues = { fiber: /\b(?:fiber|fibre|fabric|composition|cotton|polyester|wool|linen|blend)\b/i, size: /\b(?:size|sizing)\b/i, color: /\bcolou?r\b/i, dimensions: /\b(?:dimensions?|height|width|depth|length)\b/i, weight: /\b(?:weight|weighs?)\b/i, sleeve: /\bsleeves?\b/i, neckline: /\b(?:neck|neckline)\b/i };
                const cue = !b && blocks.find(x => safe(x.text) && (cues[a.id] || new RegExp(`\\b${a.id.replaceAll('-', '[ -]')}\\b`, 'i')).test(x.text));
                return { id: a.id, score: !b && blocks.length ? null : score, block: b || cue };
            });
            const details = entries.map(({ id, score, block }) => ({ id, status: score === null ? 'not_measured' : 'measured', ...(score === null ? { reason: 'An attribute is mentioned in wording the rule cannot reliably interpret.' } : { fraction: score }), ...evidence(block, `Inspected product region for ${id}; no recognizable attribute reference was found.`, url) }));
            const hit = entries.find(x => x.block);
            if (entries.some(x => x.score === null))
                findings[`C2.${key}`] = { ...unknown('Unmeasured category attributes: ' + entries.filter(x => x.score === null).map(x => x.id).join(', ') + '.'), attributes: details, ...evidence(hit?.block, '', url) };
            else
                set(`C2.${key}`, entries.reduce((s, x) => s + x.score, 0) / entries.length, hit?.block, `Inspected the complete product region for ${key} attributes.`, { attributes: details });
        }
    const priceBlocks = blocks.filter(b => safe(b.text) && !negated(b.text) && /(?:\$|\b(?:USD|EUR|GBP)\b)\s*\d+(?:\.\d{1,2})?\b|\b\d+(?:\.\d{1,2})?\s*(?:USD|EUR|GBP)\b/i.test(b.text));
    const parsedPrices = priceBlocks.flatMap(b => [...b.text.matchAll(/(?:\b(USD|EUR|GBP)\s*|([$]))(\d+(?:\.\d{1,2})?)\b|\b(\d+(?:\.\d{1,2})?)\s*(USD|EUR|GBP)\b/gi)].map(m => ({ amount: Number(m[3] || m[4]), currency: (m[1] || m[5] || '').toUpperCase() || null, block: b })));
    const uniquePrices = [...new Set(parsedPrices.map(p => `${p.amount}:${p.currency}`))];
    const price = uniquePrices.length === 1 ? parsedPrices[0] : null;
    const availabilityBlocks = blocks.filter(b => safe(b.text) && !negated(b.text) && /\b(?:in stock|out of stock|sold out|pre.?order)\b/i.test(b.text));
    const availabilityValues = [...new Set(availabilityBlocks.map(b => /\b(?:out of stock|sold out)\b/i.test(b.text) ? 'OutOfStock' : /\bpre.?order\b/i.test(b.text) ? 'PreOrder' : 'InStock'))];
    const availability = availabilityValues.length === 1 ? availabilityValues[0] : null;
    const selectedScope = b => /\b(?:selected (?:variant|size|color|configuration)|this (?:product|item)|one size|single configuration)\b/i.test(b.text) || html.singleConfiguration === true && /^selected\b/i.test(b.text) && /\b(?:t-shirt|shoes?|daypack|handbag|life vest|pfd)\b/i.test(b.text);
    if (price)
        set('C3.price', price.currency && selectedScope(price.block) && !/\b(?:from|starting at|installment|subscription|member|sale ends)\b/i.test(price.block.text) ? 1 : 0.5, price.block, '');
    else if (!priceBlocks.length)
        absent('C3.price', 'price');
    if (availability)
        set('C3.availability', selectedScope(availabilityBlocks[0]) ? 1 : 0.5, availabilityBlocks[0], '');
    else if (!availabilityBlocks.length)
        absent('C3.availability', 'availability');
    for (const [kind, id] of [['shipping', 'C3.shipping'], ['returns', 'C3.returns']]) {
        const policy = snapshot?.policies?.[kind];
        const pb = policy?.state === 'read' && Array.isArray(policy.extraction?.blocks) ? policy.extraction.blocks.filter(b => safe(b.text)) : [];
        const inline = blocks.filter(b => safe(b.text) && new RegExp(`\\b${kind === 'shipping' ? 'shipping|delivery' : 'returns?|refunds?'}\\b`, 'i').test(b.text));
        const all = [...inline, ...pb];
        const combined = all.map(b => b.text).join(' ');
        const terms = kind === 'shipping' ? [/\b(?:ship(?:ping|s)?|deliver(?:y|s)?) (?:to|within) (?:the )?[A-Za-z][A-Za-z ,]+/i, /\b(?:free shipping|shipping (?:cost|fee|rate)s? (?:is|are|calculated)|shipping (?:costs?|rates?)?\s*[:]?\s*(?:USD\s*)?\$?\d+|calculated at checkout)\b/i, /\b(?:deliver(?:y|ed|s)?|arriv(?:al|es?))[^.]{0,50}\b\d+\s*(?:to|-|–)\s*\d+\s*(?:business )?days?\b/i] : [/\b(?:unused|unworn|unopened|original condition|eligible items?)\b/i, /\b(?:within|up to)\s*\d+\s*days?\b/i, /\b(?:final sale|original packaging|return shipping|refund(?:ed)? to|restocking fee)\b/i];
        const present = terms.filter(re => re.test(combined)).length;
        if (present) {
            const b = all.find(x => terms.some(re => re.test(x.text)));
            set(id, present === 3 ? 1 : 0.5, b, '', { ...(pb.includes(b) ? { url: policy.url } : {}), policyTerms: terms.map((re, i) => ({ term: i, found: re.test(combined), evidence: all.filter(x => re.test(x.text)).map(x => evidence(x, '', pb.includes(x) ? policy.url : url)) })) });
        }
        else {
            const policyBlocks = policy?.extraction?.blocks;
            const policyComplete = policy?.state === 'read' && policy.extraction?.complete === true && Array.isArray(policyBlocks) && policyBlocks.every(b => typeof b?.text === 'string' && safe(b.text)) && !policy.extraction?.truncated && !policy.extraction?.uninterpreted;
            const productComplete = complete && html.blocks.every(b => typeof b?.text === 'string' && safe(b.text)) && (html.headings || []).every(b => typeof b?.text === 'string' && safe(b.text)) && !snapshot?.htmlLimited && !html.truncated && !html.uninterpreted;
            if (productComplete && policyComplete && policyBlocks.every(b => !b.text.trim()) && !blocks.some(b => hasAmbiguousPolicyCue(kind,b.text)))
                set(id, 0, null, `Inspected product and ${kind} policy; no terms found.`, { url: policy.url });
        }
    }
    if (selected && complete)
        for (const subcheck of ['C4.intended-use', 'C4.compatibility', 'C4.limitations', 'C4.selection']) {
            const qs = selected.decisionSupport.filter(q => q.subcheckId === subcheck);
            const assessed = [];
            for (const q of qs) {
                let trigger = true;
                if (q.applicability === 'conditional') {
                    const condition = q.id === 'pack-fit' ? /\blaptop (?:compartment|sleeve|pocket)\b/i : q.id === 'shirt-limits' ? /\b(?:treated|treatment|special finish|dry clean only|wash only)\b/i : /\b(?:waterproof|water.resistant|impact protection|surface restriction|certified for|safety rated)\b/i;
                    trigger = Boolean(match(blocks, condition));
                }
                if (!trigger) {
                    assessed.push({ questionId: q.id, status: 'not_measured', reason: 'The condition may be expressed in wording this rule cannot interpret.', ...evidence(null, `Could not determine condition: ${q.condition}`, url) });
                    continue;
                }
                const specificUse = /\b(?:designed|made|built|ideal) for\s+[^.]{4,}/i;
                const audience = /\b(?:men|women|adults?|children|kids|runners?|paddlers?|commuters?|students?|travelers?|shoppers?)\b/i;
                let found = null, fraction = 0;
                if (subcheck === 'C4.intended-use') {
                    const categoryUse = categoryId === 'running-shoes' ? /\b(?:running|runner|road|trail)\b/i : categoryId === 'casual-daypacks' ? /\b(?:everyday|commut|school|travel|day use)\b/i : categoryId === 'basic-tshirts' ? /\b(?:everyday|casual|workout|wear)\b/i : categoryId === 'personal-flotation-devices' ? /\b(?:paddl|kayak|canoe|boat|water)\w*/i : /\b(?:everyday|travel|commut|carry)\w*/i;
                    found = blocks.find(b => safe(b.text) && !negated(b.text) && specificUse.test(b.text) && categoryUse.test(b.text));
                    if (found)
                        fraction = audience.test(found.text) ? 1 : 0.5;
                }
                if (subcheck === 'C4.compatibility') {
                    const re = q.id === 'pack-fit' ? /\b(?:fits?|holds?) (?:a )?\d+(?:\.\d+)?[ -]?(?:inch|in|cm) laptop\b/i : q.id === 'shirt-fit' ? /\b(?:slim|relaxed|regular) fit\b/i : /\b(?:fits? (?:up to|a |most )|adjustable (?:fit|straps?)|(?:slim|relaxed|regular) fit)\b/i;
                    found = match(blocks, re);
                    if (found)
                        fraction = q.id === 'pack-fit' ? (/\b(?:measure|compare)\b/i.test(found.text) ? 1 : 0.5) : q.id === 'shirt-fit' ? (/\b(?:close|loose|straight|roomy|room|fitted|snug|relaxed through)\b/i.test(found.text) ? 1 : 0.5) : /\b(?:across|around|on the body|shoulder|chest|torso|waist|length|width|adjust)\b/i.test(found.text) ? 1 : 0.5;
                }
                if (subcheck === 'C4.limitations') {
                    const relevant = q.id === 'shirt-limits' ? /\b(?:fabric|treatment|care|wash|bleach|iron|dry)\b/i : /\b(?:water|rain|impact|surface|protection|certification|safety)\b/i;
                    found = blocks.find(b => safe(b.text) && relevant.test(b.text) && /\b(?:not (?:suitable|intended|designed|rated) for|only (?:suitable|intended|designed|rated) for|water.resistant (?:up to|but not)|do not (?:bleach|iron|tumble dry))\b/i.test(b.text));
                    if (found)
                        fraction = 1;
                }
                if (subcheck === 'C4.selection') {
                    const re = q.id === 'pack-selection' ? /\b(?:choose|select)\b[^.]{0,80}\b(?:capacity|liters?|litres?|pack)\b/i : /\b(?:measure (?:your|the)|choose (?:a |your )?size|size (?:chart|guide))\b/i;
                    found = match(blocks, re);
                    if (found) {
                        const relevant = categoryId === 'running-shoes' ? /\b(?:foot|feet|shoe|width)\b/i : categoryId === 'basic-tshirts' ? /\b(?:chest|waist|body|garment)\b/i : categoryId === 'casual-daypacks' ? /\b(?:carry|commute|travel|capacity)\b/i : categoryId === 'personal-flotation-devices' ? /\b(?:chest|weight|body)\b/i : /\b(?:carry|contents|strap|shoulder)\b/i;
                        fraction = relevant.test(found.text) && /\b(?:inches|inch|cm|liters?|litres?|capacity|fit preference)\b/i.test(found.text) ? 1 : 0.5;
                    }
                }
                assessed.push(found ? { questionId: q.id, status: 'measured', fraction, ...evidence(found, '', url) } : { questionId: q.id, status: 'not_measured', reason: 'The question may be answered in wording this rule cannot interpret.', ...evidence(null, `Could not interpret answer to ${q.question}`, url) });
            }
            const applicable = assessed.filter(a => a.status === 'measured');
            if (assessed.some(a => a.status === 'not_measured'))
                findings[subcheck] = { ...unknown('At least one category question or its condition could not be interpreted.'), questions: assessed };
            else if (!applicable.length && qs.length)
                findings[subcheck] = { status: 'not_applicable', rule: 'category_conditions_absent', justification: 'All conditional category questions were inspected and their conditions were absent.', conditions: assessed.map(a => ({ questionId: a.questionId, condition: a.condition, status: 'absent', evidence: a.excerpt, location: a.location, method: 'raw' })), questions: assessed, ...evidence(null, 'Conditional questions do not apply.', url) };
            else if (applicable.length)
                set(subcheck, applicable.reduce((n, a) => n + a.fraction, 0) / applicable.length, null, `Assessed ${applicable.length} applicable category question(s).`, { questions: assessed });
        }
    // Compare only explicitly scoped observations of the same field and currency.
    const scoped = blocks.filter(b => safe(b.text) && /\b(?:this product|this item|selected variant)\b/i.test(b.text));
    const comparisons = [];
    const values = scoped.flatMap(b => [...b.text.matchAll(/\b(?:this product|this item|selected variant)\s+(?:weighs|weight is)\s+(\d+(?:\.\d+)?)\s*(oz|g|kg|lb)\b/gi)].map(m => ({ value: Number(m[1]), unit: m[2].toLowerCase(), block: b })));
    if (values.length >= 2 && values.every(v => v.unit === values[0].unit))
        comparisons.push({ field: 'weight', fraction: values.every(v => v.value === values[0].value) ? 1 : 0, observations: values.map(v => evidence(v.block, '', url)) });
    // Compare repeated explicitly scoped values only for a verified single configuration;
    // previous/sale price markup prevents treating different price roles as contradictions.
    if (html.singleConfiguration === true && !(html.priceCandidates || []).some(p => p.role === 'previous')) {
        const observations = parsedPrices.filter(p => selectedScope(p.block) && p.currency);
        if (observations.length >= 2 && new Set(observations.map(p => p.block.location)).size >= 2 && observations.every(p => p.currency === observations[0].currency))
            comparisons.push({ field: 'price', fraction: observations.every(p => p.amount === observations[0].amount) ? 1 : 0, observations: observations.map(p => evidence(p.block, '', url)) });
        const observed = availabilityBlocks.filter(selectedScope);
        if (observed.length >= 2 && new Set(observed.map(b => b.location)).size >= 2) {
            const states = observed.map(b => /\b(?:out of stock|sold out)\b/i.test(b.text) ? 'OutOfStock' : /\bpre.?order\b/i.test(b.text) ? 'PreOrder' : 'InStock');
            comparisons.push({ field: 'availability', fraction: states.every(v => v === states[0]) ? 1 : 0, observations: observed.map(b => evidence(b, '', url)) });
        }
    }
    // C5 compares shopper-visible statements. Schema-to-page correspondence belongs to S3.
    if (comparisons.length && (comparisons.some(c => c.fraction === 0) || html.singleConfiguration === true && comparisons.some(c => ['price', 'availability'].includes(c.field))))
        set('C5.consistency', comparisons.reduce((n, c) => n + c.fraction, 0) / comparisons.length, null, 'Compared explicitly scoped shopper-visible observations of the same product.', { comparisons });
    const claims = blocks.filter(b => safe(b.text) && /\b(?:waterproof|water.resistant|certified|guaranteed|clinically proven|recycled|UV|organic)\b/i.test(b.text));
    if (claims.length) {
        const assessedClaims = claims.map(b => { const standard = /\b(?:certified|tested|rated|approved) (?:to|under|by) (?:ISO|ASTM|ANSI|USCG|EN)\s*[\w.-]+/i.test(b.text); const qualified = /\bnot waterproof\b/i.test(b.text); return { fraction: standard || qualified ? 1 : 0, ...evidence(b, '', url) }; });
        if (assessedClaims.some(c => c.fraction === 0))
            set('C5.claim-support', assessedClaims.reduce((n, c) => n + c.fraction, 0) / assessedClaims.length, claims[0], '', { claims: assessedClaims });
        else
            findings['C5.claim-support'] = { ...unknown('Other material claims may be expressed in wording this rule cannot detect.'), claims: assessedClaims };
    }
    const configBlock = match(blocks, /\bselected (?:variant|configuration)\s*[:\-]\s*[^.;]+/i);
    const configuration = configBlock?.text.match(/\bselected (?:variant|configuration)\s*[:\-]\s*([^.;]+)/i)?.[1]?.trim() || null;
    return { category: categoryId, findings, productName: name, variant: null, currency: price?.currency || null, facts: { price: price ? { amount: price.amount, currency: price.currency, selectedScope: selectedScope(price.block) } : null, availability, availabilityScope: availability ? selectedScope(availabilityBlocks[0]) : null, configuration } };
}
