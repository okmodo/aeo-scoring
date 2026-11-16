import test from 'node:test';
import assert from 'node:assert/strict';
import { HtmlTestRewriter } from './html-product-test-helper.mjs';
import { productHtmlAccumulator } from './html-product.mjs';
import { assessSourceAccessibility } from './structure-accessibility.mjs';

const snapshot = { url: 'https://shop.example/item', htmlLimited: null };
async function assess(markup, extra = {}, incomplete = false) {
    const rewriter = new HtmlTestRewriter();
    const collector = productHtmlAccumulator(rewriter);
    await rewriter.transform(new Response(markup)).arrayBuffer();
    return assessSourceAccessibility({ ...snapshot, ...extra }, { productHtml: collector.finish(incomplete) });
}
const values = findings => Object.fromEntries(Object.entries(findings).map(([id, f]) => [id, f.status === 'not_applicable' ? 'NA' : f.fraction]));

test('frozen source matrix: sparse product, shell, image and multiple regions', async () => {
    const cases = [
        ['<main><h1>Trail Shoe</h1><p>A shoe.</p></main>', { 'S1.delivery': 1, 'S1.readability': 1, 'S1.scope': 1, 'S1.supporting-access': 'NA' }],
        ['<main><img alt="Shoe" src="shoe.jpg"></main>', { 'S1.delivery': 1, 'S1.supporting-access': 'NA' }],
        ['<div id="app"></div><script type="application/json" id="product-data">{"name":"Shoe"}</script>', { 'S1.supporting-access': 'NA' }],
        ['<main><h1>Shoe</h1></main><main><h1>Bag</h1></main>', { 'S1.delivery': 1, 'S1.readability': 1, 'S1.scope': 0, 'S1.supporting-access': 'NA' }],
        ['<main hidden><h1>Shoe</h1></main><nav>Menu</nav>', { 'S1.delivery': 0, 'S1.supporting-access': 'NA' }]
    ];
    for (const [markup, expected] of cases) assert.deepEqual(values(await assess(markup)), expected);
    assert.deepEqual(await assess('<main><h1>Shoe</h1></main>', { htmlLimited: 'bytes' }), {});
});

test('recommendations and reviews do not become product text', async () => {
    const result = await assess('<main><h1>Shoe</h1><section class="reviews"><p>Customer review</p></section><aside><p>Other product</p></aside></main>');
    assert.equal(result['S1.delivery'].fraction, 1);
    assert.equal(result['S1.scope'].fraction, 1);
});

test('configuration selection requires association; explicit single is excluded', async () => {
    const single = await assess('<main><h1>Shoe</h1><p>This product is offered in a single configuration. No configuration-dependent values.</p></main>');
    assert.equal(single['S1.configuration'].status, 'not_applicable');
    const selected = await assess('<main><h1>Shoe</h1><p>Selected size: M. Price for selected size: USD 20.</p><select name="size"><option selected value="M">Medium</option></select></main>');
    assert.equal(selected['S1.configuration'].fraction, 1);
    const mixed = await assess('<main><h1>Shoe</h1><p>Selected size: L.</p><select name="size"><option selected value="M">Medium</option></select></main>');
    assert.equal(mixed['S1.configuration'].fraction, 0.5);
    const none = await assess('<main><h1>Shoe</h1><input type="radio" name="size" value="M"></main>');
    assert.equal(none['S1.configuration'].fraction, 0);
});

test('only inspected referenced support can establish access or failure', async () => {
    const markup = '<main><h1>Shoe</h1><a href="/shipping">Shipping policy</a></main>';
    const page = { url: 'https://shop.example/shipping', state: 'read', extraction: { complete: true, blocks: [{ text: 'Shipping details.' }] } };
    assert.equal((await assess(markup, { policies: { shipping: page } }))['S1.supporting-access'].fraction, 1);
    assert.equal((await assess(markup, { policies: { shipping: { ...page, status: 404, state: 'failed' } } }))['S1.supporting-access'].fraction, 0);
    for (const policy of [{ ...page, state: 'failed' }, { ...page, state: 'failed', status: 403 }, { ...page, extraction: { complete: false, blocks: [] } }])
        assert.equal((await assess(markup, { policies: { shipping: policy } }))['S1.supporting-access'], undefined);
});

 test('representation and delivery remain independent of product scope', async () => {
    const mixed = await assess('<main><h1>Shoe</h1><img alt="Specifications" src="specs.png"></main>');
    assert.equal(mixed['S1.readability'].fraction, 0.5);
    const photo = await assess('<main><h1>Shoe</h1><img alt="Shoe photo" src="shoe.png"></main>');
    assert.equal(photo['S1.readability'].fraction, 1);
    const deferred = await assess('<main><h1>Shoe</h1><div class="deferred-product-content"></div></main>');
    assert.equal(deferred['S1.delivery'].fraction, 0.5);
});

test('inline supporting sections and fragment references count as inspected support', async () => {
    const inline = await assess('<main><h1>Shoe</h1><a href="#specs">Specifications</a><section id="specs"><h2>Specifications</h2><p>Weight: 300 grams.</p></section></main>');
    assert.equal(inline['S1.supporting-access'].fraction, 1);
    const empty = await assess('<main><h1>Shoe</h1><section id="specs"><h2>Specifications</h2></section></main>');
    assert.equal(empty['S1.supporting-access'], undefined);
});

test('malformed support fragments remain unknown without throwing', async () => {
    const result = await assess('<main><h1>Shoe</h1><a href="#shipping%ZZ">Shipping</a></main>');
    assert.equal(result['S1.supporting-access'], undefined);
});

test('an unrelated heading ends an empty inline support section', async () => {
    const result = await assess('<main><h1>Shoe</h1><h2>Shipping</h2><h2>About us</h2><p>We make shoes.</p></main>');
    assert.equal(result['S1.supporting-access'], undefined);
});


test('single-configuration exclusion requires product-scoped proof, not a review', async () => {
    const review = await assess('<main><h1>Shoe</h1><p>No configuration-dependent values.</p><section class="reviews"><p>This product is offered in a single configuration.</p></section></main>');
    assert.equal(review['S1.configuration'], undefined);
    const product = await assess('<main><h1>Shoe</h1><p>This product is offered in a single configuration. No configuration-dependent values.</p></main>');
    assert.equal(product['S1.configuration'].status, 'not_applicable');
});
