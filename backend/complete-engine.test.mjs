import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scoreAudit } from './scoring.mjs';
import { inspectProductSchema, assessStructure } from './structure-assessment.mjs';
import { extract } from './retrieval.mjs';
import { HtmlTestRewriter } from './html-product-test-helper.mjs';
const url = 'https://shop.example/products/everyday-tshirt';
const observedAt = '2026-11-09T00:00:00.000Z';
const fixture = name => readFileSync(new URL('./fixtures/complete-engine/' + name, import.meta.url), 'utf8');
const check = (report, id) => report.criteria.flatMap(c => c.subchecks).find(c => c.id === id);
async function input() { const snapshot = { url, observedAt, body: fixture('complete-shirt.html'), htmlLimited: null, ...JSON.parse(fixture('support.json')) }; return { snapshot, extracted: await extract(snapshot, { HTMLRewriter: HtmlTestRewriter }) }; }
test('ordinary HTML supplies product facts even when Product JSON-LD is malformed', async () => {
    const { snapshot, extracted } = await input();
    extracted.jsonLd = ['{"@context":"https://schema.org","@type":"Product",broken}'];
    const report = scoreAudit(snapshot, extracted);
    assert.equal(report.productName, 'Acme Everyday T-shirt');
    assert.equal(report.category, 'basic-tshirts');
    assert.equal(check(report, 'S2.entity').fraction, 0);
    assert.equal(check(report, 'S1.identity').status, 'measured');
    assert.equal(check(report, 'S3.price').fraction, 0);
    assert.equal(report.score, null);
    assert.ok(report.evidence.some(e => e.excerpt.includes('malformed')));
});
test('alternate markup, unfinished HTML and ambiguous records do not establish absence', async () => {
    const { snapshot, extracted } = await input();
    const alternate = structuredClone(extracted);
    alternate.productHtml.otherProductMarkup = true;
    alternate.productHtml.unsupportedProductMarkup = true;
    assert.equal(inspectProductSchema(snapshot, alternate).complete, false);
    const limited = scoreAudit({ ...snapshot, htmlLimited: 'bytes' }, extracted);
    assert.equal(limited.status, 'incomplete');
    assert.equal(limited.score, null);
    const product = { '@context': 'https://schema.org', '@type': 'Product', url, name: 'Acme Everyday T-shirt' };
    const schema = inspectProductSchema(snapshot, { ...extracted, jsonLd: [JSON.stringify(product), 'malformed'] });
    assert.equal(schema.product, null);
    assert.equal(schema.ambiguous, true);
});
test('raw and structured prices only compare established selected context', async () => {
    const { snapshot, extracted } = await input();
    const product = { name: 'Acme Everyday T-shirt', offers: { price: 25, priceCurrency: 'USD', availability: 'https://schema.org/InStock' } };
    const content = { findings: {}, facts: { price: { amount: 25, currency: 'USD', selectedScope: false }, availability: 'InStock', availabilityScope: false } };
    assert.equal(assessStructure(snapshot, extracted, { schema: { product }, content })['S3.price'], undefined);
    content.facts.price.selectedScope = true;
    content.facts.availabilityScope = true;
    assert.equal(assessStructure(snapshot, extracted, { schema: { product }, content })['S3.price'].fraction, 1);
    assert.equal(assessStructure(snapshot, extracted, { schema: { product }, content })['S3.availability'].fraction, 1);
    product.offers.price = 'invalid';
    assert.equal(assessStructure(snapshot, extracted, { schema: { product }, content })['S3.price'], undefined);
});
test('point redistribution and grouped recovery retain individual evidence', async () => {
    const { snapshot, extracted } = await input();
    // Explicit source-bound findings represent a reviewed judgment fixture, not a live model result.
    const findings = {
        'C5.consistency': { status: 'measured', fraction: 0.5, evidence: [{ url, location: 'first scoped fact', excerpt: 'This product costs USD 25.00.' }, { url, location: 'second scoped fact', excerpt: 'Selected Medium Navy T-shirt: USD 25.00, in stock.' }] },
        'C5.claim-support': { status: 'not_applicable', rule: 'no_material_claims', justification: 'Reviewed complete synthetic product contains no claims requiring substantiation.', evidence: [{ url, location: 'complete synthetic product', excerpt: 'Fabric composition: 100% cotton.' }] }
    };
    const report = scoreAudit(snapshot, extracted, { semantic: { status: 'assessed', version: '1.0.0', model: 'synthetic-reviewed-judgments', findings } });
    const criterion = report.criteria.find(c => c.id === 'C5');
    assert.equal(criterion.complete, true);
    assert.equal(criterion.points, 5);
    assert.equal(check(report, 'C5.consistency').availablePoints, 10);
    assert.equal(check(report, 'C5.consistency').points, 5);
    assert.equal(report.fixes.find(f => f.id === 'improve-c5').recoverablePoints, 5);
    assert.equal(check(report, 'C5.consistency').evidenceIds.length, 2);
    const affected = report.fixes.flatMap(f => f.checkIds);
    assert.equal(new Set(affected).size, affected.length);
    for (const c of report.criteria)
        for (const s of c.subchecks)
            for (const id of s.evidenceIds)
                assert.ok(report.evidence.some(e => e.id === id));
});
test('independently adjudicated full-rubric fixture reconciles complete score, exclusions and conditional recovery', async () => {
    const { buildSemanticRequest, validateSemanticResponse } = await import('./semantic-assessment.mjs');
    const { snapshot, extracted } = await input();
    const prepared = buildSemanticRequest(snapshot, extracted, { category: 'basic-tshirts', currency: 'USD' });
    const judgments = JSON.parse(fixture('reviewed-judgments.json'));
    const semantic = validateSemanticResponse(prepared, judgments);
    const report = scoreAudit(snapshot, extracted, { semantic: { ...semantic, status: 'assessed', model: 'independently-reviewed-synthetic-judgments' } });
    const expected = JSON.parse(fixture('expected.json'));
    assert.equal(report.status, expected.status);
    assert.deepEqual(report.score, expected.score);
    assert.equal(report.coverage.notMeasured, 0);
    assert.equal(report.coverage.notApplicable, 3);
    assert.equal(report.coverage.measured + report.coverage.notMeasured + report.coverage.notApplicable, 40);
    assert.equal(check(report, 'C4.compatibility').fraction, .5);
    assert.equal(check(report, 'S2.variants').status, 'not_applicable');
    for (const c of report.criteria)
        assert.equal(c.subchecks.reduce((n, s) => n + (s.points || 0), 0), c.points);
    assert.equal(report.score.total + report.fixes.reduce((n, f) => n + (f.recoverablePoints || 0), 0), 100);
    const frozen = JSON.parse(readFileSync(new URL('../contracts/v1/examples/assessment-engine-complete.json', import.meta.url)));
    assert.deepEqual(report, frozen.report);
});
test('category exclusions and unknown attribute wording never create fabricated negative findings', () => {
    const page = identity => ({ productHtml: { complete: true, identity, blocks: [{ text: 'Fabric composition: linen blend', location: 'main/p' }], headings: [], links: [] }, coverage: { jsonLdTruncated: false }, jsonLd: [] });
    const snapshot = { url, observedAt };
    const excluded = scoreAudit(snapshot, page('Medical running shoes'));
    assert.equal(excluded.category, null);
    assert.equal(excluded.score, null);
    const shirt = scoreAudit(snapshot, page('Acme everyday T-shirt'));
    assert.equal(check(shirt, 'C2.essential').status, 'not_measured');
    assert.equal(check(shirt, 'C2.supporting').status, 'not_measured');
});
test('ambiguous raw prices or stock states never become absent structured comparisons', async () => {
    const { snapshot, extracted } = await input();
    const product = { name: 'Acme Everyday T-shirt', offers: { price: 25, priceCurrency: 'USD', availability: 'https://schema.org/InStock' } };
    const content = { findings: {}, facts: { price: null, availability: null, availabilityScope: false } };
    const findings = assessStructure(snapshot, extracted, { schema: { product }, content });
    assert.equal(findings['S3.price'], undefined);
    assert.equal(findings['S3.availability'], undefined);
    product.offers = [product.offers, { price: 30, priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock' }];
    const variants = assessStructure(snapshot, extracted, { schema: { product }, content });
    assert.equal(variants['S3.price'], undefined);
    assert.equal(variants['S3.availability'], undefined);
});
