// Accumulates source HTML evidence from the runtime's native streaming parser.
// CSS-dependent visibility cannot be established without rendering.
const MAX_ITEMS = 300, MAX_TEXT = 8192, MAX_NODES = 30000, MAX_DEPTH = 200, MAX_TOTAL = 256 * 1024;
const voids = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/;
const excluded = /^(?:script|style|template|noscript|nav|header|footer|aside|svg|canvas|button|dialog|select|textarea)$/;
const discoveryExcluded = /^(?:script|style|template|noscript|svg|canvas)$/;
const structural = /^(?:p|li|dt|dd|blockquote|h[1-6]|div|span|a|title|option)$/;
const decode = value => value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, entity => {
    const key = entity.slice(1, -1).toLowerCase(), named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (key in named)
        return named[key];
    const value = parseInt(key.slice(key[1] === 'x' ? 2 : 1), key[1] === 'x' ? 16 : 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity;
});
const clean = value => decode(value).replace(/\s+/g, ' ').trim();
const attributeNames = ['id', 'class', 'role', 'itemtype', 'typeof', 'hidden', 'inert', 'aria-hidden', 'style', 'href', 'alt', 'type', 'name', 'value', 'checked', 'disabled', 'selected', 'multiple', 'itemprop', 'content', 'data-section-type', 'data-product-recommendations', 'data-related-products', 'data-upsell', 'data-product-price-without-tax', 'data-product-price-with-tax', 'data-product-non-sale-price-without-tax', 'data-product-non-sale-price-with-tax', 'data-product-attribute', 'data-product-option-change', 'aria-label', 'itemscope', 'itemid', 'itemref', 'src', 'property', 'vocab', 'typeof'];
const wantedAttributes = new Set(attributeNames);
function attributes(element) {
    const result = {};
    if (element.attributes && typeof element.attributes[Symbol.iterator] === 'function') {
        for (const [key, value] of element.attributes) {
            const name = key.toLowerCase();
            if (wantedAttributes.has(name) && !(name in result))
                result[name] = decode(value);
        }
    }
    else {
        for (const name of attributeNames) {
            const value = element.getAttribute(name);
            if (value != null)
                result[name] = decode(value);
        }
    }
    return result;
}
function hidden(a) { return 'hidden' in a || 'inert' in a || a['aria-hidden']?.toLowerCase() === 'true' || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse))\b/i.test(a.style || ''); }
function related(a, tag = '') {
    return /^(?:product-recommendations|complementary-products|related-products|product-upsell)$/.test(tag) ||
        ['data-product-recommendations', 'data-related-products', 'data-upsell'].some(key => Object.hasOwn(a, key)) ||
        /(?:^|[\s_-])(?:recommendations?|related|upsells?|cross[\s_-]?sells?)(?:$|[\s_-])/i.test(`${a.id || ''} ${a.class || ''} ${a['data-section-type'] || ''}`);
}
function region(tag, a) { return tag === 'main' || a.role?.toLowerCase() === 'main' || /(?:^|\s)https?:\/\/schema\.org\/Product(?:\s|$)/i.test(a.itemtype || '') || /(?:^|\s)(?:productView|product-detail|product-details|product-page)(?:\s|$)/i.test(a.class || ''); }
export function productHtmlAccumulator(rewriter, { policy = false } = {}) {
    const result = { complete: true, blocks: [], headings: [], images: [], links: [], identity: { title: null, mainH1: null }, visibility: 'unknown', discoveryLinks: [], otherProductMarkup: false, selectedControls: [], priceCandidates: [], hasVariantControls: false, singleConfiguration: null, structuredRecords: [], unsupportedProductMarkup: false };
    const stack = [];
    let exhausted = false;
    let explicitSingle = false;
    let count = 0, total = 0, regionCount = 0, titles = [], titleCount = 0, available = typeof rewriter.onDocument === 'function';
    function add(list, item) {
        total += (item.text ?? item.alt ?? item.value ?? '').length;
        if (list.length >= MAX_ITEMS || total > MAX_TOTAL) {
            result.complete = false;
            return;
        }
        list.push(item);
    }
    let microCount = 0;
    function microAdd(scope, names, value) {
        if (++microCount > MAX_ITEMS || typeof value === 'string' && value.length > MAX_TEXT) {
            scope.root.complete = false;
            result.complete = false;
            return;
        }
        for (const name of names) {
            if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) {
                scope.root.complete = false;
                result.unsupportedProductMarkup = true;
                continue;
            }
            const existing = scope.record[name];
            if (existing === undefined)
                scope.record[name] = value;
            else if (Array.isArray(existing))
                existing.push(value);
            else
                scope.record[name] = [existing, value];
        }
    }
    function finish(node) {
        if (node.microOwner && !node.microScope && node.microNames.length && !node.microValueSet) {
            const value = clean(node.microText);
            if (value)
                microAdd(node.microOwner, node.microNames, value);
        }
        const text = clean(node.text);
        if (node.tag === 'title') {
            titleCount++;
            if (text)
                titles.push(text);
        }
        if (node.tag === 'a' && !node.discoveryBlocked && node.attrs.href && text) {
            add(result.discoveryLinks, { url: node.attrs.href, text, location: node.location });
            if (node.inside && !node.blocked)
                add(result.links, { url: node.attrs.href, text, location: node.location });
        }
        if (node.tag === 'option' && 'selected' in node.attrs && !('disabled' in node.attrs)) {
            const select = [...stack].reverse().find(item => item.tag === 'select');
            if (select)
                select.options.push({ name: select.attrs.name || null, value: (node.attrs.value ?? text) || null, type: 'select', location: node.location });
        }
        if (node.tag === 'select' && node.inside && node.options.length === 1 && !('multiple' in node.attrs) && !('disabled' in node.attrs) && !node.parentBlocked)
            add(result.selectedControls, node.options[0]);
        if (!node.inside || node.blocked || !text)
            return;
        if (/^(?:(?:this product|this item|available in|there is|there's)\s+)?(?:only one|a single|single) configuration[.!]?$/i.test(text) || /(?:^|[.!?]\s+)this product is offered in a single configuration(?:[.!?]|$)/i.test(text))
            explicitSingle = true;
        const currentPrice = 'data-product-price-without-tax' in node.attrs || 'data-product-price-with-tax' in node.attrs || node.attrs.itemprop === 'price';
        const previousPrice = 'data-product-non-sale-price-without-tax' in node.attrs || 'data-product-non-sale-price-with-tax' in node.attrs;
        if (currentPrice || previousPrice) {
            const match = text.match(/(?:^|[^\d])(\d+(?:[.,]\d{1,2})?)(?:[^\d]|$)/);
            if (match)
                add(result.priceCandidates, { amount: Number(match[1].replace(',', '.')), role: currentPrice ? 'current' : 'previous', text, location: node.location });
        }
        if (/^h[1-6]$/.test(node.tag))
            add(result.headings, { text, level: Number(node.tag[1]), location: node.location });
        else if (/^(?:p|li|dt|dd|blockquote)$/.test(node.tag) || (/^(?:div|span)$/.test(node.tag) && !node.hasStructuralChild && !node.blockAncestor))
            add(result.blocks, { text, location: node.location });
    }
    rewriter.on('*', { element(element) {
            if (exhausted || ++count > MAX_NODES || stack.length >= MAX_DEPTH) {
                exhausted = true;
                result.complete = false;
                return;
            }
            const tag = (element.tagName || '').toLowerCase(), a = attributes(element), parent = stack.at(-1);
            const parentScope = [...stack].reverse().find(frame => frame.microScope)?.microScope;
            const rawBlocked = !!parent?.rawBlocked || discoveryExcluded.test(tag) || /^(?:nav|header|footer|aside)$/.test(tag) || related(a, tag);
            const ownRegion = !parent?.inside && region(tag, a);
            if (ownRegion)
                regionCount++;
            if (/(?:^|\s)https?:\/\/schema\.org\/Product(?:\s|$)/i.test(a.itemtype || '') || /(?:^|\s)(?:schema:)?Product(?:\s|$)/i.test(a.typeof || ''))
                result.otherProductMarkup = true;
            const node = { tag, attrs: a, location: `html:element:${count}`, text: '', inside: !!parent?.inside || ownRegion || policy && (tag === 'body' || !!parent?.inside), blocked: !!parent?.blocked || hidden(a) || excluded.test(tag) || related(a, tag), discoveryBlocked: !!parent?.discoveryBlocked || hidden(a) || discoveryExcluded.test(tag), blockAncestor: !!parent?.blockAncestor || /^(?:p|li|dt|dd|blockquote|h[1-6])$/.test(parent?.tag || ''), hasStructuralChild: false, parentBlocked: !!parent?.blocked, options: [], rawBlocked, microOwner: parentScope, microScope: null, microNames: (a.itemprop || '').trim().split(/\s+/).filter(Boolean), microText: '', microValueSet: false };
            const scopeType = (a.itemtype || '').match(/^https?:\/\/schema\.org\/(Product|Offer|Brand|UnitPriceSpecification)$/)?.[1];
            if (!rawBlocked && a.typeof && /(?:^|\s)(?:schema:)?Product(?:\s|$)/i.test(a.typeof))
                result.unsupportedProductMarkup = true;
            if ('itemscope' in a && !rawBlocked) {
                if (scopeType && (scopeType === 'Product' && !parentScope || parentScope && node.microNames.length)) {
                    const record = { '@type': scopeType };
                    if (a.itemid)
                        record['@id'] = a.itemid;
                    let root;
                    if (scopeType === 'Product') {
                        root = { format: 'microdata', record, location: node.location, complete: true };
                        if (result.structuredRecords.length < 20)
                            result.structuredRecords.push(root);
                        else {
                            result.complete = false;
                            root.complete = false;
                        }
                    }
                    else
                        root = parentScope.root;
                    node.microScope = { record, root };
                    if (parentScope)
                        microAdd(parentScope, node.microNames, record);
                    if ('itemref' in a) {
                        root.complete = false;
                        result.unsupportedProductMarkup = true;
                    }
                }
                else if (parentScope || (a.itemtype || '').includes('Product')) {
                    if (parentScope)
                        parentScope.root.complete = false;
                    result.unsupportedProductMarkup = true;
                    node.microScope = { record: {}, root: parentScope?.root || { complete: false } };
                }
            }
            if (node.microOwner && !node.microScope && node.microNames.length && !rawBlocked) {
                const attr = tag === 'meta' ? 'content' : /^(?:a|area|link)$/.test(tag) ? 'href' : /^(?:audio|embed|iframe|img|source|track|video)$/.test(tag) ? 'src' : /^(?:data|meter)$/.test(tag) ? 'value' : null;
                if (attr && a[attr] != null) {
                    microAdd(node.microOwner, node.microNames, a[attr]);
                    node.microValueSet = true;
                }
                else if (voids.test(tag)) {
                    node.microOwner.root.complete = false;
                    result.unsupportedProductMarkup = true;
                }
            }
            const configurationContext = parent?.configurationContext || /(?:size|colou?r|material|variant|option|swatch)/i.test(`${a.name || ''} ${a.id || ''} ${a['aria-label'] || ''} ${a['data-product-attribute'] || ''}`) || 'data-product-option-change' in a;
            node.configurationContext = configurationContext;
            if (node.inside && !node.rawBlocked && configurationContext && (tag === 'select' || tag === 'input' && /^(?:radio|checkbox)$/i.test(a.type || '')))
                result.hasVariantControls = true;
            if (parent && /^(?:div|section|article|form|p|li|dt|dd|blockquote|h[1-6])$/.test(tag))
                parent.hasStructuralChild = true;
            if (node.inside && !node.blocked && tag === 'img')
                add(result.images, { alt: a.alt ?? '', location: node.location });
            if (node.inside && !node.blocked && tag === 'input' && /^(?:radio|checkbox)$/i.test(a.type || '') && 'checked' in a && !('disabled' in a))
                add(result.selectedControls, { name: a.name || null, value: a.value || null, type: a.type.toLowerCase(), location: node.location });
            if (voids.test(tag) || element.canHaveContent === false)
                return;
            stack.push(node);
            // The JSON-LD handler owns this end tag; it releases the shared frame.
            if (tag === 'script' && (a.type || '').toLowerCase() === 'application/ld+json')
                return;
            if (typeof element.onEndTag !== 'function') {
                result.complete = false;
                return;
            }
            try {
                element.onEndTag(() => {
                    const index = stack.lastIndexOf(node);
                    if (index < 0)
                        return;
                    if (index !== stack.length - 1)
                        result.complete = false;
                    while (stack.length > index)
                        finish(stack.pop());
                });
            }
            catch {
                stack.pop();
                if (!node.blocked && !node.discoveryBlocked)
                    result.complete = false;
            }
        } });
    if (available)
        rewriter.onDocument({ text(chunk) {
                const top = stack.at(-1);
                if (exhausted || !top)
                    return;
                if (!top.rawBlocked) {
                    const activeScope = [...stack].reverse().find(node => node.microScope)?.microScope;
                    for (const node of stack)
                        if (node.microOwner && node.microOwner === activeScope && !node.microScope && node.microNames.length && !node.microValueSet) {
                            if (node.microText.length + chunk.text.length > MAX_TEXT) {
                                node.microOwner.root.complete = false;
                                result.complete = false;
                            }
                            else
                                node.microText += chunk.text;
                        }
                }
                if (top.discoveryBlocked)
                    return;
                for (const node of stack) {
                    if ((!node.inside && !['a', 'title', 'option'].includes(node.tag)) || (/^(?:div|span)$/.test(node.tag) && (node.hasStructuralChild || node.blockAncestor)) || (top.blocked && node.tag !== 'a' && node.tag !== 'title' && node.tag !== 'option') || !structural.test(node.tag) || (node.blocked && node.tag !== 'title' && node.tag !== 'a' && node.tag !== 'option'))
                        continue;
                    if (node.text.length + chunk.text.length > MAX_TEXT) {
                        node.text = (node.text + chunk.text).slice(0, MAX_TEXT);
                        result.complete = false;
                    }
                    else
                        node.text += chunk.text;
                }
            } });
    return { endJsonLd() {
            const node = stack.at(-1);
            if (node?.tag === 'script' && (node.attrs.type || '').toLowerCase() === 'application/ld+json')
                stack.pop();
        }, finish(incomplete = false) {
            if (!available || incomplete || stack.length)
                result.complete = false;
            while (stack.length)
                finish(stack.pop());
            if (!policy && regionCount !== 1)
                result.complete = false;
            if (!result.complete || incomplete)
                for (const record of result.structuredRecords)
                    record.complete = false;
            if (result.complete && explicitSingle && !result.hasVariantControls)
                result.singleConfiguration = true;
            result.identity.title = titleCount === 1 ? titles[0] || null : null;
            const h1s = result.headings.filter(item => item.level === 1);
            result.identity.mainH1 = h1s.length === 1 ? h1s[0].text : null;
            return result;
        } };
}
