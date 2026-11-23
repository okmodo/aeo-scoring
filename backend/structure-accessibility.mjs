// Source accessibility is assessed independently of content completeness and schema.
import { explicitSelectedConfiguration } from './selected-configuration.mjs';

const supportPattern = /\b(?:shipping|delivery|returns?|refunds?|polic(?:y|ies)|guides?|size charts?|specifications?|manuals?|instructions?|warrant(?:y|ies))\b/i;
const text = value => typeof value === 'string' && value.trim().length > 0;

export function assessSourceAccessibility(snapshot, extracted) {
    const html = extracted?.productHtml;
    if (!html) return {};
    const source = html.sourceObservation;
    const complete = Boolean(source?.complete && !snapshot?.htmlLimited && !snapshot?.browser?.coverage?.initialLimited && snapshot?.browser?.coverage?.initialAvailable !== false);
    const findings = {};
    if (!complete) return findings;
    const put = (id, fraction, excerpt, location = 'initial product HTML') => {
        findings[id] = { status: 'measured', fraction, url: snapshot.url, location, excerpt };
    };
    const na = (id, rule, justification) => {
        findings[id] = { status: 'not_applicable', rule, justification, url: snapshot.url, location: 'initial product HTML', excerpt: justification };
    };
    const blocks = [...(source.headings || []), ...(source.blocks || [])].filter(b => text(b.text));
    const hasText = blocks.length > 0;
    const regions = source?.regions;
    const informationImage = source.informationalImages > 0;
    // A serialized state container does not establish what product information it contains.
    const opaque = false;
    const delivered = hasText || informationImage || opaque || source.productImages > 0;
    if (delivered) put('S1.delivery', source.deferredContent ? 0.5 : 1, source.deferredContent ? 'Some product source content is present and additional product content is explicitly marked for deferred loading.' : 'Product content is present in the initial HTML.');
    else if (source.deferredContent) put('S1.delivery', 0, 'Product content is explicitly marked for deferred loading and no product content was found in the initial HTML.');
    else if (!source.opaqueScripts) put('S1.delivery', 0, 'Complete initial source inspection found no product content.');

    if (hasText && (informationImage || opaque)) put('S1.readability', 0.5, 'Ordinary text and separately identified image or opaque product information are both present.');
    else if (hasText) put('S1.readability', 1, 'Observed product information is available as ordinary source text.');
    else if (informationImage || opaque) put('S1.readability', 0, 'Identified product information is available only in an image or opaque data.');

    if (regions === 1 && (source.headings || []).filter(h => h.level === 1).length === 1 && hasText) put('S1.scope', 1, 'A single source product region contains the product heading and text.');
    else if (regions > 1 && new Set((source.headings || []).filter(h => h.level === 1).map(h => h.text.trim().toLowerCase())).size > 1) put('S1.scope', 0, 'Distinct product headings occur in multiple source regions without a unique primary product.');
    else if (regions > 1 && hasText) put('S1.scope', 0.5, 'Multiple source regions prevent a unique product association.');
    else if (regions === 1 && hasText) put('S1.scope', 0.5, 'Text is in one product region, but its product identity is not uniquely established.');

    const controls = (source.selectedControls || []).filter(c => text(c.name) && text(c.value));
    const explicitNoDependentValues = blocks.some(b => /\bno configuration-dependent (?:values|price|availability)\b/i.test(b.text));
    const explicitSingle = blocks.some(b => /^(?:(?:this product|this item|available in|there is|there's)\s+)?(?:only one|a single|single) configuration[.!]?$|(?:^|[.!?]\s+)this product is offered in a single configuration(?:[.!?]|$)/i.test(b.text));
    if (html.singleConfiguration === true && explicitSingle && !source.hasVariantControls && !controls.length && explicitNoDependentValues) na('S1.configuration', 'single_configuration', 'Source explicitly establishes a single configuration and no configuration-dependent values.');
    else if (source.hasVariantControls) {
        const selected = blocks.filter(b => explicitSelectedConfiguration(b.text, controls));
        const associatedValue = selected.some(b => /\b(?:price|availability|stock|sku)\s+(?:for|of)\s+(?:the\s+)?selected\s+(?:size|colou?r|width|model|configuration|variant)\s*[:=]\s*[^.;]+/i.test(b.text));
        if (selected.length && controls.length && associatedValue) put('S1.configuration', 1, 'A selected control and displayed configuration-dependent value are associated in the same source statement.');
        else if (controls.length || selected.length) put('S1.configuration', 0.5, 'A selection is present, but its association with displayed values is not established.');
        else if (source.controls > 0 && source.controls === source.unselectedControls) put('S1.configuration', 0, 'Configuration controls were inspected without a selected value.');
    }
    const links = (source.links || []).filter(link => text(link.url) && supportPattern.test(`${link.text || ''} ${link.url}`));
    const inline = source.inlineSupport || [];
    const outcomes = inline.map(section => section.readable ? 'read' : 'unknown');
    if (!links.length && !inline.length && complete) na('S1.supporting-access', 'no_supporting_references', 'Complete source inspection found no referenced guides, specifications, or policies.');
    else {
        outcomes.push(...links.map(link => {
            let url;
            try { url = new URL(link.url, snapshot.url).href; } catch { return 'unknown'; }
            const target = new URL(url);
            const current = new URL(snapshot.url);
            if (target.hash && target.origin === current.origin && target.pathname === current.pathname && target.search === current.search) {
                let fragment;
                try { fragment = decodeURIComponent(target.hash.slice(1)); } catch { return 'unknown'; }
                const section = inline.find(item => item.id === fragment);
                return section?.readable ? 'read' : 'unknown';
            }
            const page = Object.values(snapshot.policies || {}).find(p => { try { return new URL(p?.url, snapshot.url).href === url; } catch { return false; } });
            if (!page) return 'unknown';
            if (page.status === 404 || page.status === 410 || page.state === 'login_required') return 'broken';
            if (page.state === 'read' && page.extraction?.complete && (page.extraction.blocks || []).some(b => text(b.text))) return 'read';
            return 'unknown';
        }));
        if (outcomes.every(x => x === 'read')) put('S1.supporting-access', 1, 'All referenced supporting pages were read as ordinary text.', 'referenced supporting pages');
        else if (outcomes.includes('read') && outcomes.includes('broken') && !outcomes.includes('unknown')) put('S1.supporting-access', 0.5, 'Some referenced supporting pages were readable and others explicitly unavailable.', 'referenced supporting pages');
        else if (outcomes.every(x => x === 'broken')) put('S1.supporting-access', 0, 'All referenced supporting pages were explicitly unavailable or require login.', 'referenced supporting pages');
    }
    return findings;
}
