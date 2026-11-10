import test from 'node:test';
import assert from 'node:assert/strict';
import { productHtmlAccumulator } from './html-product.mjs';
import { HtmlTestRewriter } from './html-product-test-helper.mjs';
async function extract(html, options) {
    const rewriter = new HtmlTestRewriter(), accumulator = productHtmlAccumulator(rewriter, options);
    await rewriter.transform(new Response(html)).text();
    return accumulator.finish();
}
test('extracts main text with provenance while excluding hidden and related content', async () => {
    const result = await extract('<title>Bag</title><nav><a href="/shipping">Shipping</a></nav><main><h1>Leather <em>Bag</em></h1><p>Useful &amp; detailed.</p><p hidden>Invisible</p><div class="related-products"><p>Other item</p></div><img alt="Front view"></main>');
    assert.equal(result.complete, true);
    assert.equal(result.identity.mainH1, 'Leather Bag');
    assert.deepEqual(result.blocks.map(x => x.text), ['Useful & detailed.']);
    assert.equal(result.images[0].alt, 'Front view');
    assert.match(result.blocks[0].location, /^html:element:\d+$/);
    assert.equal(result.discoveryLinks[0].url, '/shipping');
});
test('parses quoted delimiters, nested text, explicit selections and prices', async () => {
    const result = await extract('<main><h1>Vest</h1><div title="4 > 2"><span>Waterproof</span></div><span data-product-price-without-tax>$99.00</span><span data-product-non-sale-price-without-tax>$159.00</span><select name="size"><option value="s">Small</option><option value="m" selected>Medium</option></select><input type="radio" name="color" value="red" checked></main>');
    assert.ok(result.blocks.some(item => item.text === 'Waterproof'));
    assert.deepEqual(result.selectedControls.map(item => item.value), ['m', 'red']);
    assert.deepEqual(result.priceCandidates.map(item => [item.amount, item.role]), [[99, 'current'], [159, 'previous']]);
    assert.equal(result.singleConfiguration, null);
});
test('policy pages can use body content without a main region', async () => {
    const html = '<body><nav>Menu</nav><h1>Returns</h1><p>Return within 30 days.</p></body>';
    assert.equal((await extract(html)).complete, false);
    const policy = await extract(html, { policy: true });
    assert.equal(policy.complete, true);
    assert.equal(policy.blocks[0].text, 'Return within 30 days.');
});
test('single configuration requires an explicit scoped statement and no configuration controls', async () => {
    const single = await extract('<main><h1>Vest</h1><p>Only one configuration.</p></main>');
    assert.equal(single.singleConfiguration, true);
    assert.equal(single.hasVariantControls, false);
    const variant = await extract('<main><p>Single configuration</p><div data-product-attribute="swatch" hidden><input type="radio" name="attribute[1]" value="red"></div></main>');
    assert.equal(variant.hasVariantControls, true);
    assert.equal(variant.singleConfiguration, null);
    const unspecified = await extract('<main><h1>Vest</h1><p>Adjustable straps.</p></main>');
    assert.equal(unspecified.singleConfiguration, null);
});
test('splitting text into chunks retains the same extraction', async () => {
    const html = '<main><h1>Travel Bag</h1><p>A durable bag for travel.</p><a href="/shipping">Shipping</a></main>';
    const expected = await extract(html);
    const rewriter = new HtmlTestRewriter();
    rewriter.chunkSize = 3;
    const accumulator = productHtmlAccumulator(rewriter);
    await rewriter.transform(new Response(html)).text();
    assert.deepEqual(accumulator.finish(), expected);
});
test('extracts scoped Product microdata including nested Offer, Brand, repeated values and hidden identifiers', async () => {
    const html = '<main itemscope itemtype="https://schema.org/Product"><h1 itemprop="name">Travel <em>Bag</em></h1><meta itemprop="sku" content="ABC"><span hidden itemprop="mpn">M-1</span><a itemprop="image" href="/a.jpg">Photo</a><a itemprop="image" href="/b.jpg">Second</a><div itemprop="brand" itemscope itemtype="https://schema.org/Brand"><span itemprop="name">Acme</span></div><div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="price" content="19.00"><meta itemprop="priceCurrency" content="USD"><link itemprop="availability" href="https://schema.org/InStock"></div><aside class="related"><span itemprop="name">Other product</span></aside></main>';
    const result = await extract(html);
    assert.equal(result.structuredRecords.length, 1);
    const { record, complete } = result.structuredRecords[0];
    assert.equal(complete, true);
    assert.equal(record.name, 'Travel Bag');
    assert.equal(record.mpn, 'M-1');
    assert.deepEqual(record.image, ['/a.jpg', '/b.jpg']);
    assert.deepEqual(record.brand, { '@type': 'Brand', name: 'Acme' });
    assert.deepEqual(record.offers, { '@type': 'Offer', price: '19.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' });
});
test('microdata with itemref or unsupported RDFa remains incomplete', async () => {
    const unsupported = await extract('<main itemscope itemtype="https://schema.org/Product" itemref="elsewhere"><h1 itemprop="name">Bag</h1></main>');
    assert.equal(unsupported.structuredRecords[0].complete, false);
    assert.equal(unsupported.unsupportedProductMarkup, true);
    const rdfa = await extract('<main typeof="schema:Product"><h1>Bag</h1></main>');
    assert.equal(rdfa.unsupportedProductMarkup, true);
});
test('recognizes an explicit single configuration sentence in a longer paragraph', async () => {
    const result = await extract('<main><h1>Vest</h1><p>Ready to wear. This product is offered in a single configuration. Ships soon.</p></main>');
    assert.equal(result.singleConfiguration, true);
});
test('recommendation components cannot supply facts for the audited product', async () => {
    const result = await extract('<main><h1>Acme T-shirt</h1><p>Fabric: cotton.</p><product-recommendations><p>Fabric: polyester.</p><img alt="Other shirt"></product-recommendations><section data-section-type="related-products"><p>Color: Red.</p></section></main>');
    assert.equal(result.complete, true);
    assert.deepEqual(result.blocks.map(b => b.text), ['Fabric: cotton.']);
    assert.equal(result.images.length, 0);
});
test('element limit suppresses later text rather than losing hidden-script context', async () => {
    const result = await extract('<main><p>Before ' + '<i></i>'.repeat(30005) + '<script>private-script-text</script>After</p></main>');
    assert.equal(result.complete, false);
    assert.doesNotMatch(JSON.stringify(result), /private-script-text|After/);
});
