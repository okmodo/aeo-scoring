// Raw HTML evidence rules. These observations do not claim computed visibility.
import { assessCompleteProductFields } from './product-fields.mjs';
import { selectProductVariant } from './product-variants.mjs';
const context = new Set(['https://schema.org', 'https://schema.org/', 'http://schema.org', 'http://schema.org/']);
const norm = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const type = (record, name) => [record?.['@type']].flat().some(v => [name, 'https://schema.org/' + name, 'http://schema.org/' + name].includes(v));
const text = value => typeof value === 'string' && value.trim().length > 0;
const equivalentUrl = (a, b) => {
    try {
        const x = new URL(a, b), y = new URL(b);
        x.hash = '';
        y.hash = '';
        return x.href === y.href;
    }
    catch {
        return false;
    }
};
export function inspectProductSchema(snapshot, extracted) {
    const html = extracted?.productHtml;
    const bounded = Boolean(html?.complete && !snapshot.htmlLimited && extracted.coverage?.jsonLdTruncated === false);
    const result = { complete: bounded, product: null, findings: {}, ambiguous: false, malformed: false };
    if (!html)
        return result;
    const source = snapshot.url;
    let markupLocation = 'script[type="application/ld+json"]; inspected product markup';
    const finding = (fraction, excerpt, extra = {}) => ({ status: 'measured', fraction, url: source,
        location: markupLocation, excerpt, ...extra });
    const products = [], groups = [];
    let unsupported = Boolean(html.unsupportedProductMarkup ?? html.otherProductMarkup);
    for (const [index, script] of (extracted.jsonLd ?? []).entries()) {
        if (script.length > 131072) {
            unsupported = true;
            continue;
        }
        try {
            const parsed = JSON.parse(script);
            const inherited = parsed?.['@context'];
            const records = Array.isArray(parsed) ? parsed : [parsed, ...(Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [])];
            for (const record of records) {
                if (!record || typeof record !== 'object')
                    continue;
                if (['@included', '@nest', '@reverse'].some(k => Object.hasOwn(record, k)))
                    unsupported = true;
                const isProduct = type(record, 'Product'), isGroup = type(record, 'ProductGroup');
                if (!isProduct && !isGroup)
                    continue;
                if (!context.has(record['@context'] ?? inherited)) {
                    unsupported = true;
                    continue;
                }
                (isGroup ? groups : products).push({ record, index });
            }
        }
        catch {
            result.malformed = true;
        }
    }
    for (const item of html.structuredRecords || []) {
        if (!item.complete) {
            unsupported = true;
            continue;
        }
        if (type(item.record, 'Product'))
            products.push({ record: { '@context': 'https://schema.org', ...item.record }, index: null, location: item.location, format: item.format });
    }
    result.complete = bounded && !unsupported;
    if (!result.complete)
        return result;
    const heading = (typeof html.identity === 'string' ? html.identity : html.identity?.mainH1) || html.headings?.find(h => h.level === 1)?.text;
    const matches = products.filter(({ record }) => typeof record.url === 'string' ? equivalentUrl(record.url, source) :
        text(heading) && norm(record.name) === norm(heading));
    const selectedGroup = groups.length === 1 && !products.length ? selectProductVariant(groups[0].record, source) : null;
    let selected, selectedObservation;
    if (selectedGroup) {
        selected = selectedGroup.record;
        result.variant = selectedGroup.variant;
        result.findings['S2.variants'] = finding(1, selectedGroup.evidence.excerpt);
    }
    else if (matches.length === 1 && !groups.length) {
        selectedObservation = matches[0];
        selected = matches[0].record;
    }
    const ids = ['S2.entity', 'S2.core-properties', 'S2.offer', 'S2.identifiers', 'S2.variants'];
    if (!selected) {
        if (products.length || groups.length) {
            result.ambiguous = true;
            result.findings['S2.entity'] = finding(0.5, 'Product candidates were parsed, but the audited product or selected configuration could not be uniquely associated.');
            return result;
        }
        for (const id of ids)
            result.findings[id] = finding(0, result.malformed ?
                'Complete retained raw markup inspection found malformed JSON-LD and no parseable associated Product.' :
                'Complete raw markup inspection found no schema.org Product in supported markup.');
        if (html.singleConfiguration === true)
            result.findings['S2.variants'] = { status: 'not_applicable', rule: 'single_configuration', justification: 'Complete product-scoped HTML explicitly establishes a single configuration.', url: source, location: 'product configuration', excerpt: 'The product page explicitly states that only one configuration is offered.' };
        return result;
    }
    if (['hasVariant', 'isVariantOf', 'variesBy'].some(k => Object.hasOwn(selected, k)) && !selectedGroup) {
        result.ambiguous = true;
        result.findings['S2.entity'] = finding(0.5, 'A Product is associated with the page, but its variant relationship requires unresolved context.');
        return result;
    }
    if (result.malformed && !selectedObservation?.format) {
        result.ambiguous = true;
        result.findings['S2.entity'] = finding(0.5, 'An associated Product was observed, but other malformed markup prevents complete association inspection.');
        return result;
    }
    if (selectedObservation?.format)
        markupLocation = `${selectedObservation.format} at ${selectedObservation.location}`;
    result.product = selected;
    result.findings['S2.entity'] = finding(1, 'A parseable schema.org Product is uniquely associated with the audited page.');
    const validImage = value => {
        try {
            return text(value) && ['http:', 'https:'].includes(new URL(value, source).protocol);
        }
        catch {
            return false;
        }
    };
    const core = [text(selected.name) && selected.name.trim().length >= 3, text(selected.description) && selected.description.trim().length >= 20, Array.isArray(selected.image) ? selected.image.length > 0 && selected.image.every(validImage) : validImage(typeof selected.image === 'object' ? selected.image?.url : selected.image)];
    result.findings['S2.core-properties'] = finding(core.filter(Boolean).length / 3, `Associated Product core properties: name ${core[0] ? 'present' : 'missing or unusable'}, description ${core[1] ? 'present' : 'missing or unusable'}, image ${core[2] ? 'present' : 'missing or unusable'}.`);
    const fields = assessCompleteProductFields(selected, source, { observedAt: snapshot.observedAt });
    for (const id of ['S2.offer', 'S2.identifiers']) {
        const field = fields[id];
        if (field?.status === 'measured')
            result.findings[id] = finding(field.fraction, field.excerpt);
        else if (field)
            result.findings[id] = field;
    }
    if (!result.findings['S2.variants']) {
        if (html.singleConfiguration === true)
            result.findings['S2.variants'] = {
                status: 'not_applicable', rule: 'single_configuration', justification: 'Product-scoped evidence explicitly establishes a single configuration.',
                url: source, location: 'product configuration', excerpt: 'Explicit single-configuration product evidence.'
            };
        else if (html.hasVariantControls === true)
            result.findings['S2.variants'] = finding(0, 'The product has configuration controls but no verified structured variant associations.');
    }
    return result;
}
export function assessStructure(snapshot, extracted, { schema, content } = {}) {
    const html = extracted?.productHtml;
    if (!html)
        return {};
    const findings = {};
    const blocks = html.blocks ?? [];
    const corpus = blocks.map(b => b.text).join('\n');
    const source = snapshot.url;
    const put = (id, fraction, excerpt, location = 'inspected product HTML') => {
        findings[id] = { status: 'measured', fraction, url: source, location, excerpt };
    };
    const name = typeof html.identity === 'string' ? html.identity : html.identity?.mainH1 || html.headings?.find(h => h.level === 1)?.text;
    const facts = content?.facts ?? {};
    const contentFindings = content?.findings ?? {};
    const copy = (from, to) => {
        const f = contentFindings[from];
        if (f?.status === 'measured')
            findings[to] = { ...f };
    };
    if (name)
        put('S1.identity', name.trim().split(/\s+/).length >= 3 && (facts.configuration || html.singleConfiguration === true) ? 1 : 0.5, name, 'product h1');
    else if (html.complete)
        put('S1.identity', 0, 'No product identity was found in the complete scoped raw HTML.');
    const explanation = contentFindings['C1.explanation'];
    if (explanation?.status === 'measured')
        findings['S1.description'] = { ...explanation };
    const prices = html.priceCandidates?.filter(p => p.role === 'current') || [];
    if (prices.length === 1)
        put('S1.price', /\b(?:USD|EUR|GBP|CAD|AUD)\b/.test(prices[0].text) ? 1 : 0.5, prices[0].text, prices[0].location);
    else
        copy('C3.price', 'S1.price');
    copy('C3.availability', 'S1.availability');
    const attributeChecks = ['C2.essential', 'C2.supporting'].map(id => contentFindings[id]);
    if (attributeChecks.every(f => f?.status === 'measured')) {
        const attributes = attributeChecks.flatMap(f => f.attributes || []);
        if (attributes.length)
            findings['S1.specifications'] = { status: 'measured', fraction: attributes.reduce((n, a) => n + (a.fraction || 0), 0) / attributes.length, url: source, location: 'product attributes in initial HTML', excerpt: 'Inspected the essential and supporting category attributes in source HTML.', attributes };
    }
    const headings = html.headings ?? [];
    if (name && text(extracted.title))
        put('S4.title', norm(extracted.title).includes(norm(name)) ? 1 : 0.5, `Page title: ${extracted.title}; product heading: ${name}.`, 'head title; product h1');
    else if (html.complete)
        put('S4.title', name || text(extracted.title) ? 0.5 : 0, 'Complete title and product-heading inspection found incomplete or absent labels.');
    const sections = headings.filter(h => h.level >= 2 && /description|details|specifications|features|materials|care|size|fit|shipping|returns/i.test(h.text));
    if (sections.length)
        put('S4.organization', sections.length >= 2 && contentFindings['C2.essential']?.fraction > 0 ? 1 : 0.5, sections.map(h => h.text).join('; '), sections.map(h => h.location).join('; '));
    else if (html.complete)
        put('S4.organization', 0, 'Complete scoped HTML inspection found no informative section headings.');
    const images = html.images ?? [];
    if (images.length) {
        const nameWords = norm(name).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3);
        const useful = images.filter(i => text(i.alt) && nameWords.some(w => norm(i.alt).includes(w)) && !/^(?:image|photo|picture|product|img)[\s\d_-]*$/i.test(i.alt));
        put('S4.image-alternatives', useful.length / images.length, `${useful.length} of ${images.length} inspected product images have useful text alternatives.`, images.map(i => i.location).join('; ').slice(0, 1000));
    }
    else if (html.complete)
        put('S4.image-alternatives', 0, 'Complete scoped product-image inspection found no informative product image alternatives.');
    if (schema?.complete && !schema.product && !schema.ambiguous) {
        for (const id of ['S3.identity', 'S3.price', 'S3.availability', 'S3.optional-claims'])
            put(id, 0, 'No parseable associated Product markup is available for comparison with the inspected raw product content.');
    }
    else if (schema?.product) {
        const p = schema.product;
        if (name && text(p.name))
            put('S3.identity', norm(name) === norm(p.name) ? 1 : 0, `Raw product heading: ${name}; structured name: ${p.name}.`, 'product h1; associated Product.name');
        const offer = p.offers;
        if (facts.price?.selectedScope === true && offer && !Array.isArray(offer) && offer.price != null && text(offer.priceCurrency)) {
            if (facts.price.currency && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(offer.price)) && /^[A-Z]{3}$/.test(offer.priceCurrency))
                put('S3.price', Number(facts.price.amount) === Number(offer.price) && facts.price.currency === offer.priceCurrency ? 1 : 0, `Raw price ${facts.price.amount} ${facts.price.currency}; structured price ${offer.price} ${offer.priceCurrency}.`, 'product price; associated Offer');
        }
        else if (html.complete && (offer == null || typeof offer === 'object' && !Array.isArray(offer) && !Object.hasOwn(offer, 'price') && !Object.hasOwn(offer, 'priceSpecification') && !Object.hasOwn(offer, '@id')))
            put('S3.price', 0, 'Complete raw and associated structured-price inspection found a missing comparison component.');
        if (facts.availabilityScope === true && facts.availability && typeof offer?.availability === 'string') {
            const state = offer.availability.replace(/^https?:\/\/schema\.org\//, '');
            const canonical = { 'in_stock': 'InStock', 'out_of_stock': 'OutOfStock', 'preorder': 'PreOrder', 'in stock': 'InStock', 'out of stock': 'OutOfStock' }[norm(facts.availability)] ?? facts.availability;
            if (['InStock', 'OutOfStock', 'PreOrder', 'PreSale', 'BackOrder', 'Discontinued', 'InStoreOnly', 'OnlineOnly', 'LimitedAvailability', 'SoldOut'].includes(state))
                put('S3.availability', canonical === state ? 1 : 0, `Raw availability ${facts.availability}; structured availability ${state}.`, 'product availability; associated Offer');
        }
        else if (html.complete && (offer == null || typeof offer === 'object' && !Array.isArray(offer) && !Object.hasOwn(offer, 'availability') && !Object.hasOwn(offer, '@id')))
            put('S3.availability', 0, 'Complete raw and structured-availability inspection found a missing comparison component.');
        const optional = ['color', 'size', 'material', 'sku', 'mpn'].filter(k => text(p[k]));
        if (!optional.length && !['aggregateRating', 'review', 'additionalProperty', 'weight', 'height', 'width', 'depth'].some(k => Object.hasOwn(p, k)))
            findings['S3.optional-claims'] = {
                status: 'not_applicable', rule: 'no_optional_claims', justification: 'The completely inspected associated Product supplies no optional claim groups.', url: source,
                location: 'associated Product', excerpt: 'No optional structured claim groups supplied.'
            };
        else if (optional.length && !['aggregateRating', 'review', 'additionalProperty', 'weight', 'height', 'width', 'depth'].some(k => Object.hasOwn(p, k)) && optional.every(k => new RegExp(`(?:^|\\n)${k}\\s*[:=]\\s*[^\\n]+`, 'i').test(corpus))) {
            const agreeing = optional.filter(k => {
                const value = corpus.match(new RegExp(`(?:^|\\n)${k}\\s*[:=]\\s*([^\\n]+)`, 'i'))?.[1];
                return norm(value) === norm(p[k]);
            });
            put('S3.optional-claims', agreeing.length === optional.length ? 1 : 0, `Compared labeled raw ${optional.join(', ')} with corresponding structured values; ${agreeing.length} agree.`, 'labeled raw product attributes; associated Product');
        }
    }
    return findings;
}
