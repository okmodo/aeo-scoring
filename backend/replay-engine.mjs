// Offline native-runtime replay. Requires backend's locked dev dependencies.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'vite';
const args = process.argv.slice(2);
const [file, url] = args;
if (!file || !url)
    throw new Error('Usage: node backend/replay-engine.mjs <HTML file> <page URL> [--support JSON] [--facts JSON | --judgments JSON] [--output JSON]');
const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : null;
const html = readFileSync(file, 'utf8');
if (Buffer.byteLength(html) > 1024 * 1024)
    throw new Error('Offline replay input exceeds the production HTML limit');
const support = option('--support') ? JSON.parse(readFileSync(option('--support'), 'utf8')) : {};
const judgments = option('--judgments') ? JSON.parse(readFileSync(option('--judgments'), 'utf8')) : null;
const facts = option('--facts') ? JSON.parse(readFileSync(option('--facts'), 'utf8')) : null;
if (facts && judgments) throw new Error('Choose facts or reviewed judgments, not both');
const compilation = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false, lib: { entry: new URL('./engine-runtime-worker.mjs', import.meta.url).pathname, formats: ['es'], fileName: 'replay' } } });
const output = Array.isArray(compilation) ? compilation.flatMap(item => item.output) : compilation.output;
const script = output.find(item => item.type === 'chunk')?.code;
if (!script)
    throw new Error('Missing replay bundle');
const require = createRequire(new URL('./package.json', import.meta.url));
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2026-11-05' }));
try {
    const response = await runtime.dispatchFetch('https://offline-replay.test/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ html, url, support, judgments, facts }) });
    if (!response.ok)
        throw new Error('Native runtime replay failed: ' + (await response.text()).slice(0, 500));
    const result = await response.json();
    if (option('--output'))
        writeFileSync(option('--output'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ page: url, product: result.report.productName, status: result.report.status, score: result.report.score, coverage: result.report.coverage, productRegionComplete: result.extracted.productHtml.complete, textBlocks: result.extracted.productHtml.blocks.length, priceCandidates: result.extracted.productHtml.priceCandidates, structuredFormats: result.extracted.productHtml.structuredRecords.map(r => r.format), judgmentOrigin: facts ? 'supplied fact response validated against source' : judgments ? 'explicit reviewed offline fixture' : 'deterministic observations only' }, null, 2));
}
finally {
    await runtime.dispose();
}
