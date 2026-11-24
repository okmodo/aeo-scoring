// Install only static assets into the local nginx bind mount.
// The bridge changes the destination of browser API requests, not their results.
import { copyFile, cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [buildPath, sitePath] = process.argv.slice(2);
if (!buildPath || !sitePath) throw new Error('Supply the built dist directory and local nginx document root.');
const build = resolve(buildPath);
const site = resolve(sitePath);
const shim = `const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== 'https://aeo-audit-public-20261105.aeo-scoring-kk7.workers.dev') {
    return realFetch(input, init);
  }
  if (!url.pathname.startsWith('/api/v1/')) throw new Error('Local review route unavailable');
  return realFetch(location.origin + url.pathname + url.search, {
    method: request.method,
    headers: request.headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
    signal: request.signal,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  });
};`;
const notice = '<aside style="padding:10px;text-align:center;background:#081334;color:#fff;font:14px system-ui">Local queue review · Fictional product and AI results</aside>';
const html = await readFile(resolve(build, 'index.html'), 'utf8');
if (!html.includes('<head>') || !html.includes('<body>')) throw new Error('Unexpected static build layout.');
await mkdir(site, { recursive: true });
await cp(resolve(build, 'assets'), resolve(site, 'assets'), { recursive: true });
await copyFile(resolve(build, 'favicon.svg'), resolve(site, 'favicon.svg'));
await writeFile(resolve(site, 'stepper-local-review.js'), shim);
await writeFile(resolve(site, 'index.html.next'), html
  .replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="connect-src \'self\'"><script src="/stepper-local-review.js"></script>')
  .replace('<body>', '<body>' + notice));
await rename(resolve(site, 'index.html.next'), resolve(site, 'index.html'));
