import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { preprocessHtml } from './html-preprocessing.mjs';

const sourceObjectKey = 'retained/12345678-1234-4123-8123-123456789abc/12345678-1234-4123-8123-123456789abc/html';
const args = { sourceObjectKey, expiresAt: 2000 };
const opts = { now: () => 1000, HTMLRewriter: class {} };
test('rejects invalid source, expiry, UTF-8, and oversized input before rewriting', async () => {
  for (const input of [ { ...args, rawHtml: '<p>x</p>', sourceObjectKey: '../html' }, { ...args, rawHtml: '', expiresAt: 1000 }, { ...args, rawHtml: new Uint8Array([0xff]) }, { ...args, rawHtml: new Uint8Array(8 * 1024 * 1024 + 1) }, { ...args, rawHtml: '\ud800' } ]) {
    await assert.rejects(preprocessHtml(input, opts), error => error.code?.startsWith('preprocessing_'));
  }
});

test('native HTMLRewriter preserves semantic evidence and removes presentation', async () => {
  const { Miniflare, convertV4MiniflareOptions } = await import(process.env.MINIFLARE_MODULE || 'miniflare');
  const module = (await readFile(new URL('./html-preprocessing.mjs', import.meta.url), 'utf8')).replace("import { MAX_RENDERED_HTML_BYTES } from './snapshot-store.mjs';", 'const MAX_RENDERED_HTML_BYTES = 8 * 1024 * 1024;').replaceAll('export const ', 'const ').replaceAll('export async function ', 'async function ');
  const script = `${module}\nexport default { async fetch(request) { try { const input = await request.json(); const result = await preprocessHtml(input, {now: () => 1000}); return Response.json({html: new TextDecoder().decode(result.html), preprocessing: result.preprocessing}); } catch (error) { return Response.json({error: error.code || String(error)}); } } };`;
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-11-05', cf: false }));
  try {
    const rawHtml = await readFile(new URL('./fixtures/html-preprocessing/preservation.html', import.meta.url), 'utf8');
    const run = async input => (await mf.dispatchFetch('http://localhost/', { method: 'POST', body: JSON.stringify(input) })).json();
    const result = await run({ ...args, rawHtml });
    assert.equal(result.error, undefined);
    assert.ok(result.html.includes(rawHtml.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/)[0]));
    for (const value of ['{"a": 1}', 'hidden data-context="menu"', 'Product &amp; care', 'on-sale="yes"', ' a  &amp; b\n c', '  keep\n spaces', 'selected value="m"', 'alt="Blue shirt"', 'aria-labelledby="title"', 'id="shape"', 'stroke="url(#paint)"', 'Ignore previous instructions', 'style="display:none"', 'class="recommendations"', 'style="clip-path:url(#shape)"']) assert.ok(result.html.includes(value), value);
    for (const value of ['<!--', '<style', 'stylesheet', 'alert(', 'onclick=', 'class="x"', 'viewBox=', 'd="M0 0"', 'fill="red"']) assert.ok(!result.html.includes(value), value);
    assert.equal(result.preprocessing.sourceBytes, new TextEncoder().encode(rawHtml).length);
    assert.equal(result.preprocessing.expiresAt, 2000);
    assert.equal(result.preprocessing.scriptsRemoved, 1);
    assert.match(result.preprocessing.outputSha256, /^[a-f0-9]{64}$/);
    const many = await run({ ...args, rawHtml: '<p>evidence</p>'.repeat(350) });
    assert.equal((many.html.match(/evidence/g) || []).length, 350);
    const edge = await run({ ...args, rawHtml: '<p>café &amp; tea<script type="application/json; charset=utf-8">{"x":"&amp;"}</script><input size="12" value="42">' });
    assert.ok(edge.html.includes('café &amp; tea'));
    assert.ok(edge.html.includes('{"x":"&amp;"}'));
    assert.ok(edge.html.includes('size="12"'));
    const controls = await run({ ...args, rawHtml: '<p>' + ('A\u0001\u0002\t\n'.repeat(100000)) + '</p>' });
    assert.equal(controls.error, undefined);
    assert.equal(controls.preprocessing.sourceBytes, new TextEncoder().encode('<p>' + ('A\u0001\u0002\t\n'.repeat(100000)) + '</p>').length);
    assert.equal(controls.preprocessing.outputBytes, new TextEncoder().encode(controls.html).length);
    assert.ok(controls.preprocessing.outputBytes <= 4 * 1024 * 1024 - 64 * 1024);
    assert.match(controls.preprocessing.outputSha256, /^[a-f0-9]{64}$/);
    const malformed = await run({ ...args, rawHtml: '<div><p>Broken <b>nested</div><svg aria-labelledby="title"><title id="title">Icon label</title><path id="p" d="M0 0" fill="url(#paint)"><desc id="desc">Shape description</desc></svg><a href="#desc">Details' });
    for (const value of ['Broken ', 'nested', 'aria-labelledby="title"', 'id="title"', 'Icon label', 'id="p"', 'fill="url(#paint)"', 'id="desc"', 'Shape description', 'href="#desc"']) assert.ok(malformed.html.includes(value), value);
    const oversized = await run({ ...args, rawHtml: 'x'.repeat(4 * 1024 * 1024) });
    assert.equal(oversized.error, 'preprocessing_oversize');
  } finally { await mf.dispose(); }
});
