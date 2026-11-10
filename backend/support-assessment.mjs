/* global URL */
import crawlers from '../config/crawlers.v1.json' with { type: 'json' };
import { assessGuideContext } from './website-guides.mjs';
const groups = [['S5.search', crawlers.scoring.search.botIds], ['S5.ai-retrieval', crawlers.scoring.aiRetrieval.botIds]];
const measured = (fraction, url, location, excerpt) => ({ status: 'measured', fraction, url, location, excerpt });
const unknown = reason => ({ status: 'not_measured', reason });
// Only explicit Markdown links are considered. Code and HTML make inspection
// ambiguous, so no negative conclusion is drawn from such a guide.
function links(guide, origin) {
    if (!guide || typeof guide.text !== 'string' || guide.text.length > 8192 || /```|~~~|<!--|<[^>]*>|`|\]\s*:/m.test(guide.text))
        return null;
    try {
        if (new URL(guide.url).origin !== origin)
            return null;
    }
    catch {
        return null;
    }
    const result = [];
    for (const line of guide.text.split(/\r?\n/)) {
        if (/^(?: {4}|\t)/.test(line))
            continue;
        const match = line.match(/^ {0,3}(?:[-*+] )?\[([^\]]+)\]\(([^\s()]+)\)\s*$/);
        if (!match) {
            if (/\[|\]/.test(line))
                return null;
            continue;
        }
        try {
            const u = new URL(match[2], guide.url);
            // Keep external and fragment links as unresolved rather than calling them absent.
            if (!u.username && !u.password && ['http:', 'https:'].includes(u.protocol))
                result.push(u.href);
            else
                return null;
        }
        catch { /* Invalid links cannot establish useful references. */ }
    }
    return result;
}
function usefulPolicy(policy) {
    if (policy?.state !== 'read' || !policy.extraction || policy.extraction.coverage?.html === false)
        return false;
    const e = policy.extraction;
    return Array.isArray(e.blocks) && e.blocks.some(block => typeof block?.text === 'string' &&
        block.text.trim().length >= 30 && /\b(?:ship(?:ping|ped)?|deliver(?:y|ed)?|return(?:s|ed)?|refund(?:s|ed)?|exchange(?:s|d)?)\b/i.test(block.text));
}
function guideChecks(result, guides, key, stateKey, ids, sourceUrl, policyList, inspectedReferences) {
    const guide = guides?.[key];
    const state = guides?.[stateKey];
    const fallback = new URL(key === 'llms' ? '/llms.txt' : '/AGENTS.md', sourceUrl).href;
    if (state === 'absent') {
        for (const id of ids)
            result[id] = measured(0, fallback, 'Root guide request', 'The root guide was confirmed absent.');
        return;
    }
    if (!guide || state === 'unknown')
        return;
    const existing = assessGuideContext(guide, sourceUrl, key);
    if (existing)
        result[ids[0]] = { status: 'measured', ...existing };
    else if (typeof guide.text === 'string' && !guide.text.trim())
        result[ids[0]] = measured(0, guide.url, 'Root guide content', 'The guide was empty.');
    const found = links(guide, new URL(sourceUrl).origin);
    if (!found)
        return;
    const references = inspectedReferences.filter(r => r && found.includes(r.url));
    const meaningful = r => r.state === 'read' && Array.isArray(r.extraction?.blocks) && r.extraction.blocks.some(b => typeof b?.text === 'string' && b.text.trim().length >= 30 && (r.type === 'catalog' ? /\b(?:products?|catalog|collection|equipment|clothing|goods|items)\b/i : /\b(?:help|support|shipping|delivery|orders?|returns?|refunds?)\b/i).test(b.text));
    const catalog = found.includes(sourceUrl) || references.some(r => r.type === 'catalog' && meaningful(r));
    const relevant = policyList.filter(p => p?.url && found.includes(p.url));
    const working = relevant.some(usefulPolicy) || references.some(r => r.type === 'help' && meaningful(r));
    const unresolved = found.some(link => link !== sourceUrl && !relevant.some(p => p.url === link && ['read', 'absent'].includes(p.state)) && !references.some(r => r.url === link && ['read', 'absent'].includes(r.state)));
    if (catalog && working)
        result[ids[1]] = measured(1, guide.url, 'Guide links and inspected pages', 'The guide links to an inspected catalog or product and a useful inspected policy or help page.');
    else if ((catalog || working) && !unresolved)
        result[ids[1]] = measured(0.5, guide.url, 'Guide links and inspected pages', 'The guide has a useful inspected reference but does not establish both catalog and policy or help references.');
    else if (!found.length)
        result[ids[1]] = measured(0, guide.url, 'Guide links', 'No supported reference links were found in the inspected guide.');
}
export function assessSupport(snapshot = {}, extracted = {}) {
    void extracted;
    const result = {};
    const policy = snapshot.crawlerPolicy;
    if (policy?.version === crawlers.version && typeof policy.url === 'string' && Array.isArray(policy.observations) && [200, 404, 410].includes(policy.httpStatus)) {
        for (const [id, ids] of groups) {
            const statuses = ids.map(botId => {
                const observations = policy.observations.filter(o => o?.botId === botId);
                return observations.length === 1 ? observations[0].status : null;
            });
            if (statuses.every(s => s === 'allowed' || s === 'disallowed'))
                result[id] = measured(statuses.filter(s => s === 'allowed').length / ids.length, policy.url, 'robots.txt policy for the final product URL', ids.map((id, i) => `${id}: ${statuses[i]}`).join(', '));
        }
    }
    const sitemap = snapshot.sitemap;
    if (sitemap?.state === 'absent' && typeof sitemap.url === 'string') {
        result['S6.usable'] = measured(0, sitemap.url, 'Root sitemap request', 'The default sitemap was confirmed absent and no sitemap alternatives were declared.');
    }
    else if (sitemap?.usableSource) {
        if (sitemap.brokenRelevantReferences === true)
            result['S6.usable'] = measured(0.5, sitemap.usableSource, 'sitemap XML document and relevant references', 'A usable sitemap listing was found, but a relevant reference was confirmed broken.');
        else if (sitemap.complete === true)
            result['S6.usable'] = measured(1, sitemap.usableSource, 'sitemap XML document', 'A bounded same-origin sitemap inspection verified a parseable URL listing.');
        if (sitemap.inclusionSource)
            result['S6.inclusion'] = measured(1, sitemap.inclusionSource, 'sitemap XML url/loc', 'A sitemap URL entry exactly matches the final audited product URL.');
        else if (sitemap.complete === true)
            result['S6.inclusion'] = measured(0, sitemap.usableSource, 'sitemap XML url/loc', 'The completely inspected sitemap listing did not include the audited product URL.');
    }
    else if (sitemap?.inclusionSource)
        result['S6.inclusion'] = measured(1, sitemap.inclusionSource, 'sitemap XML url/loc', 'A sitemap URL entry exactly matches the final audited product URL.');
    try {
        if (typeof snapshot.url === 'string') {
            const policies = Object.values(snapshot.policies || {});
            const references = Array.isArray(snapshot.inspectedReferences) ? snapshot.inspectedReferences : [];
            guideChecks(result, snapshot.guides, 'llms', 'llmsState', ['S7.identity', 'S7.links'], snapshot.url, policies, references);
            guideChecks(result, snapshot.guides, 'agents', 'agentsState', ['S8.context', 'S8.guidance'], snapshot.url, policies, references);
        }
    }
    catch { /* malformed inputs remain unmeasured */ }
    for (const id of ['S5.search', 'S5.ai-retrieval', 'S6.usable', 'S6.inclusion', 'S7.identity', 'S7.links', 'S8.context', 'S8.guidance'])
        result[id] ||= unknown('Available inspection does not establish this check.');
    return result;
}
