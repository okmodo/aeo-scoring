import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'rolldown';

// Local wall time is useful for spotting gross regressions, not a measurement of
// Cloudflare production CPU. The generated pages contain no merchant content.
test('native workerd derives and scores large verified prepared pages', {timeout: 60000}, async () => {
  const {Miniflare, convertV4MiniflareOptions} = await import(process.env.MINIFLARE_MODULE || 'miniflare');
  const dir = await mkdtemp(path.join(tmpdir(), 'aeo-derived-runtime-'));
  let mf;
  try {
    const entry = path.join(dir, 'entry.mjs');
    const derivedPath = path.resolve('backend/prepared-derived.mjs');
    const scoringPath = path.resolve('backend/scoring.mjs');
    await writeFile(entry, `import {derivePreparedObservations, MAX_DERIVED_HTML_BYTES} from ${JSON.stringify(derivedPath)};
      import {scoreAudit} from ${JSON.stringify(scoringPath)};
      const enc = new TextEncoder();
      const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
      export default { async fetch(request) {
        const size = new URL(request.url).pathname === '/large' ? MAX_DERIVED_HTML_BYTES : 435704;
        const name = 'Example Trail X24P Running Shoe', url = 'https://example.com/item';
        const product = {'@context':'https://schema.org','@type':'Product',url,name,model:'X24P',brand:'Example'};
        const prefix = '<html><head><title>'+name+'</title><script type="application/ld+json">'+JSON.stringify(product)+'</script></head><body><main><h1>'+name+'</h1>';
        const suffix = '</main></body></html>';
        const paragraph = '<p>Example product details and specifications for shoppers.</p>';
        const remaining = size-prefix.length-suffix.length;
        const html = prefix + paragraph.repeat(Math.floor(remaining/paragraph.length)) + 'x'.repeat(remaining%paragraph.length) + suffix;
        const p = {version:'simplified-html-v1',representation:'cleaned_rendered_html',originalCapturePreserved:true,outputBytes:enc.encode(html).length,outputSha256:await hash(html)};
        const prepared = {version:'1',html,preprocessing:p}, json=JSON.stringify(prepared), preparedHash=await hash(json);
        const snapshot = {url,observedAt:'2026-11-20T00:00:00Z',retrievalMethod:'browser_api_content',preprocessing:p,browser:{renderedHtml:html,initialExtracted:{coverage:{html:false}},coverage:{initialAvailable:false,complete:false}}};
        const input = {snapshot,prepared,source:{preparedHash,sha256:preparedHash,bytes:enc.encode(json).length,objectKey:'retained/item/prepared'}};
        const derived = await derivePreparedObservations(input);
        if (!derived) return Response.json({error:'derivation failed'}, {status:500});
        const report = scoreAudit(snapshot,{}, {initialExtracted:snapshot.browser.initialExtracted,deterministicExtracted:derived,requireAiAssessment:true});
        const checks = report.criteria.flatMap(c=>c.subchecks);
        return Response.json({size,score:report.score,title:checks.find(c=>c.id==='S4.title'),initial:checks.filter(c=>c.id.startsWith('S1.')||c.id.startsWith('S2.'))});
      }};`);
    await build({input:entry,platform:'node',external:id=>/^(?:cloudflare:|node:)/.test(id),output:{dir,format:'esm'},onwarn(warning){throw new Error(warning.message);}});
    const script = await readFile(path.join(dir,'entry.js'),'utf8');
    mf = new Miniflare(convertV4MiniflareOptions({name:'derived-runtime',modules:true,script,compatibilityDate:'2026-11-05',cf:false}));
    for (const route of ['/representative','/large']) {
      const start = performance.now();
      const response = await mf.dispatchFetch('http://localhost'+route);
      const result = await response.json();
      const wallMs = Math.round(performance.now()-start);
      console.log(`Native prepared derive+score ${result.size} bytes: ${wallMs} ms local wall time`);
      assert.equal(response.status,200,JSON.stringify(result));
      assert.equal(result.title.fraction,1,JSON.stringify(result.title));
      assert.equal(result.score,null);
      assert.ok(result.initial.length > 0);
      assert.ok(result.initial.every(check=>check.status==='not_measured'),JSON.stringify(result.initial));
    }
  } finally {
    await mf?.dispose();
    await rm(dir,{recursive:true,force:true});
  }
});
