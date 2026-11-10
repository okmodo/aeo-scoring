import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSupport } from './support-assessment.mjs';
import crawlers from '../config/crawlers.v1.json' with { type: 'json' };
const url = 'https://example.com/products/boots';
const policy = 'https://example.com/policies/shipping';
const body = `# Example\n\nWe sell outdoor equipment and clothing for hikers.\n\n[Boots](${url})\n[Shipping](${policy})`;
const guides = { llmsState: 'found', agentsState: 'found', llms: { url: 'https://example.com/llms.txt', text: body }, agents: { url: 'https://example.com/AGENTS.md', text: body + '\nAgents should consult the shipping policy for delivery information.' } };
const observed = { state: 'read', url: policy, extraction: { blocks: [{ text: 'Orders ship within two business days and delivery takes three to five days.' }], complete: true } };
test('scores inspected guides and references, preserving unknown failed references', () => {
    const full = assessSupport({ url, guides, policies: { shipping: observed } });
    for (const id of ['S7.identity', 'S7.links', 'S8.context', 'S8.guidance'])
        assert.equal(full[id].fraction, 1);
    const partial = assessSupport({ url, guides, policies: { shipping: { url: policy, state: 'absent' } } });
    assert.equal(partial['S7.links'].fraction, 0.5);
    assert.equal(assessSupport({ url, guides, policies: {} })['S7.links'].status, 'not_measured');
    const unknown = assessSupport({ url, guides, policies: { shipping: { url: policy, state: 'failed' } } });
    assert.equal(unknown['S7.links'].status, 'not_measured');
});
test('confirmed guide absence is zero but ambiguous case is unknown', () => {
    const r = assessSupport({ url, guides: { llmsState: 'absent', agentsState: 'unknown' } });
    assert.equal(r['S7.identity'].fraction, 0);
    assert.equal(r['S7.links'].fraction, 0);
    assert.equal(r['S8.context'].status, 'not_measured');
});
test('sitemap exclusion requires complete inspection', () => {
    const sitemap = { usableSource: 'https://example.com/sitemap.xml' };
    assert.equal(assessSupport({ sitemap })['S6.inclusion'].status, 'not_measured');
    assert.equal(assessSupport({ sitemap: { ...sitemap, complete: true } })['S6.inclusion'].fraction, 0);
});
test('crawler observations support partial, disallowed and missing policy results', () => {
    const ids = Object.values(crawlers.scoring).flatMap(g => g.botIds);
    const crawlerPolicy = { version: crawlers.version, url: 'https://example.com/robots.txt', httpStatus: 200, observations: ids.map((botId, i) => ({ botId, status: i === 0 ? 'disallowed' : 'allowed' })) };
    const r = assessSupport({ crawlerPolicy });
    assert.equal(r['S5.search'].fraction, 0.5);
    assert.equal(r['S5.ai-retrieval'].fraction, 1);
    const missing = { ...crawlerPolicy, httpStatus: 404, observations: crawlerPolicy.observations.map(o => ({ ...o, status: 'allowed' })) };
    assert.equal(assessSupport({ crawlerPolicy: missing })['S5.search'].fraction, 1);
    assert.equal(assessSupport({ crawlerPolicy: { ...missing, httpStatus: 503 } })['S5.search'].status, 'not_measured');
});
test('guide identity and site purpose do not require a product link', () => {
    const text = '# Example\n\nWe sell outdoor equipment and clothing for hikers.';
    const r = assessSupport({ url, guides: { llmsState: 'found', agentsState: 'found', llms: { url: 'https://example.com/llms.txt', text }, agents: { url: 'https://example.com/AGENTS.md', text } } });
    assert.equal(r['S7.identity'].fraction, 1);
    assert.equal(r['S8.context'].fraction, 0.5);
    assert.equal(r['S7.links'].fraction, 0);
    const incomplete = assessSupport({ url, guides: { llmsState: 'found', llms: { url: 'https://example.com/llms.txt', text: 'We sell outdoor equipment and clothing for hikers.' } } });
    assert.equal(incomplete['S7.identity'].fraction, 0.5);
    const irrelevant = assessSupport({ url, guides: { agentsState: 'found', agents: { url: 'https://example.com/AGENTS.md', text: '# Repository\nRun tests before making changes.' } } });
    assert.equal(irrelevant['S8.context'].fraction, 0);
    const unsafe = assessSupport({ url, guides: { llmsState: 'found', llms: { url: 'https://example.com/llms.txt', text: '<!-- # Example -->\nWe sell outdoor equipment and clothing for hikers.' } } });
    assert.equal(unsafe['S7.identity'].status, 'not_measured');
});
test('confirmed absent default sitemap differs from failed or malformed inspection', () => {
    const source = 'https://example.com/sitemap.xml';
    const absent = assessSupport({ sitemap: { state: 'absent', url: source } });
    assert.equal(absent['S6.usable'].fraction, 0);
    assert.equal(absent['S6.inclusion'].status, 'not_measured');
    for (const state of ['unknown', 'failed'])
        assert.equal(assessSupport({ sitemap: { state, url: source } })['S6.usable'].status, 'not_measured');
});
test('uninspected external and fragment references are not absence', () => {
    for (const link of ['https://external.example/help', '#policy', '/other']) {
        const guide = { url: 'https://example.com/llms.txt', text: `# Example\n\n[Help](${link})` };
        assert.equal(assessSupport({ url, guides: { llmsState: 'found', llms: guide } })['S7.links'].status, 'not_measured');
    }
});
test('inspected catalog and help may establish full useful references', () => {
    const catalog = 'https://example.com/catalog';
    const help = 'https://example.com/help';
    const guide = { url: 'https://example.com/llms.txt', text: `[Catalog](${catalog})\n[Help](${help})` };
    const inspectedReferences = [
        { url: catalog, state: 'read', type: 'catalog', extraction: { blocks: [{ text: 'Browse our collection of outdoor equipment and clothing.' }] } },
        { url: help, state: 'read', type: 'help', extraction: { blocks: [{ text: 'Find answers about deliveries, order support and returns.' }] } },
    ];
    assert.equal(assessSupport({ url, guides: { llmsState: 'found', llms: guide }, inspectedReferences })['S7.links'].fraction, 1);
    inspectedReferences[1].state = 'failed';
    assert.equal(assessSupport({ url, guides: { llmsState: 'found', llms: guide }, inspectedReferences })['S7.links'].status, 'not_measured');
});
test('broken relevant sitemap references cannot earn full usability', () => {
    const sitemap = { usableSource: 'https://example.com/sitemap.xml', complete: true, brokenRelevantReferences: true };
    assert.equal(assessSupport({ sitemap })['S6.usable'].fraction, 0.5);
    assert.equal(assessSupport({ sitemap: { ...sitemap, complete: false, brokenRelevantReferences: false } })['S6.usable'].status, 'not_measured');
});
