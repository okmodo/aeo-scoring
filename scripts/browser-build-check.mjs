import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'rolldown';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

// Compile the real Worker and pinned browser SDK, with only platform modules external.
// This verifies packaging; it does not establish native browser behavior or CPU cost.
const output = await mkdtemp(path.join(tmpdir(), 'aeo-browser-bundle-'));
try {
  const pkg = JSON.parse(await readFile('backend/package.json', 'utf8'));
  assert.equal(pkg.dependencies['@cloudflare/playwright'], '1.3.6');
  const backendRequire = createRequire(path.resolve('backend/package.json'));
  const cfPackagePath = backendRequire.resolve('cf/package.json');
  const cfPackage = JSON.parse(await readFile(cfPackagePath,'utf8'));
  const {bindings} = await import(pathToFileURL(path.resolve(path.dirname(cfPackagePath),cfPackage.exports['./config'].import)));
  assert.equal(typeof bindings.browser, 'function');
  assert.ok(bindings.browser());
  await build({
    input: 'backend/public-worker.mjs',
    platform: 'node',
    external: id => /^(?:cloudflare:|node:)/.test(id),
    output: { dir: output, format: 'esm', minify: true },
    onwarn(warning) { throw new Error(warning.message); },
  });
  const files = await readdir(output);
  const scripts = files.filter(file => file.endsWith('.mjs') || file.endsWith('.js'));
  assert.ok(scripts.length > 0);
  let bytes = 0;
  for (const file of scripts) bytes += (await readFile(path.join(output,file))).byteLength;
  assert.ok(bytes < 10 * 1024 * 1024, `Worker bundle exceeds paid-plan upload bound: ${bytes}`);
  console.log(`Browser Worker compiled: ${bytes} bytes (uncompressed; native validation remains separate).`);
} finally { await rm(output, { recursive: true, force: true }); }
const tests = (await readdir('backend')).filter(file => /^browser-.*\.test\.mjs$/.test(file)).sort();
assert.ok(tests.length >= 6);
const result = spawnSync(process.execPath, ['--test', ...tests.map(file => `backend/${file}`)], {stdio:'inherit',timeout:90000});
assert.equal(result.status, 0, 'Browser regression suite failed');
