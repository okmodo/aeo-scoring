// Conservative source-only recognition; callers must establish complete safe product scope.
const forbidden = /\b(?:no|not|never|without|neither|cannot|can't|isn't|is not|other|another|different|separate)\b/i;
const canonical = value => ({s:'small',m:'medium',l:'large',xl:'extra large',xs:'extra small'}[value.toLowerCase()] || value.toLowerCase());
const placeholder = /^(?:select|choose|pick|measure|compare|see|view|check|consult|refer|guide|chart|options?|sizes?|colou?rs?|variants?|unknown|n\/a)$/i;
export function explicitSelectedConfiguration(text, controls = []) {
    if (typeof text !== 'string' || forbidden.test(text) || /\b(?:ignore|disregard|system prompt|assistant instructions?)\b/i.test(text)) return false;
    const m=/^\s*selected\s+(size|colou?r|width|model|configuration)\s*[:=-]\s*([a-z0-9]+(?:\.[0-9]+)?(?:-[a-z0-9]+)*)(?=\s|[;,!?]|$|\.(?!\d))/i.exec(text);
    if (/\b(?:or|either|unavailable|sold out|out of stock|not available|options?)\b/i.test(text)) return false;
    if (!m || placeholder.test(m[2])) return false;
    const dimension=m[1].toLowerCase().replace('colour','color'), value=m[2];
    const rest=text.slice(m.index+m[0].length);
    if (dimension!=='configuration' && !/^(?:\s*\((?:US|UK|EU|AU)\)|\s+(?:US|UK|EU|AU))?\s*(?:[.;!?]|$)/i.test(rest)) return false;
    if (dimension==='color' && !/^(?:black|white|red|blue|navy|green|gray|grey|brown|pink|beige|yellow|purple|orange)$/i.test(value)) return false;
    if (dimension==='size' && !/^(?:xxs|xs|s|m|l|xl|xxl|xxxl|small|medium|large|\d+(?:\.\d+)?)$/i.test(value)) return false;
    if (dimension==='width' && !/^(?:regular|standard|wide|narrow|[2-6]?[a-e]{1,2})$/i.test(value)) return false;
    if (dimension==='configuration' && !/^(?:xxs|xs|s|m|l|xl|xxl|small|medium|large|black|white|red|blue|navy|green|gray|grey|brown|pink|beige|\d+(?:\.\d+)?)$/i.test(value)) return false;
    if (dimension==='configuration') {
        const tail=rest.split(/[;.!?]/,1)[0];
        if (tail && !/^[\s,()0-9-]*(?:(?:us|uk|eu|au|sizing|size|color|colour|width|model|xxs|xs|s|m|l|xl|xxl|small|medium|large|black|white|red|blue|navy|green|gray|grey|brown|pink|beige)\b[\s,()0-9-]*)*$/i.test(tail)) return false;
    }
    for (const c of controls) {
        const name=String(c?.name || '').toLowerCase().replace('colour','color');
        if (typeof c.value!=='string' || !c.value.trim()) continue;
        if (name===dimension && canonical(c.value.trim())!==canonical(value)) return false;
        if (dimension==='configuration' && ['size','color','width','model'].includes(name)) {
            const values=text.slice(m.index+m[0].length-m[2].length).split(/[\s,;:()]+/).map(v=>v.replace(/[.!?]+$/,'')).filter(Boolean).map(canonical);
            if (!values.includes(canonical(c.value.trim()))) return false;
        }
    }
    return true;
}
export function hasIncludedPhysicalItem(text) {
    if (typeof text !== 'string' || forbidden.test(text) || /\b(?:guide|chart|instructions?|article|page|review|customer)\b/i.test(text)) return false;
    return /\b(?:includes?|contains?|comes with)\s+(?:(?:one|a|an|\d+)\s+)?(?:t-shirts?|shirts?|shoes?|pairs?(?:\s+of\s+shoes?)?|packs?|bags?|vests?|items?|products?|straps?|handles?|accessor(?:y|ies))\b/i.test(text);
}

export function associatedConfigurationItems(selected, included, observations = []) {
    if (!selected || !included || !hasIncludedPhysicalItem(included.text)) return false;
    if (selected === included) return true;
    return Boolean(selected.sourceId && selected.sourceId===included.sourceId && selected.location && selected.location===included.location && observations.indexOf(included) === observations.indexOf(selected) + 1 );
}
