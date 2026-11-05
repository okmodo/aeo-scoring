// Upload only static build assets using a short-lived Pages upload token on stdin.
// Project creation and deployment are separate, explicitly authorized API calls.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

const [directory, manifestFile] = process.argv.slice(2);
if (!directory || !manifestFile || process.argv.length !== 4) throw new Error('Usage: node scripts/pages-upload-assets.mjs BUILD_DIR MANIFEST_FILE < token');
const root = resolve(directory);
if (resolve(manifestFile).startsWith(root + sep)) throw new Error('Manifest must be outside the build directory');
let token = '';
for await (const chunk of process.stdin) token += chunk;
token = token.trim();
if (!token || /\s/.test(token)) throw new Error('Supply one upload token on stdin');
const types = { '.html': 'text/html', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const manifest = {};
const assets = new Map();
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Build output must not contain symlinks');
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) {
      const name = relative(root, path).split(sep).join('/');
      if (['_worker.js', '_worker.bundle', '_routes.json', '_headers', '_redirects'].includes(name)) throw new Error(`Unexpected special Pages file: ${name}`);
      const data = await readFile(path);
      if (data.length > 25 * 1024 * 1024) throw new Error(`File exceeds Pages free limit: ${name}`);
      const ext = extname(name).toLowerCase();
      const contentType = types[ext];
      if (!contentType) throw new Error(`Unknown MIME type: ${name}`);
      // Include MIME type in the key so identical bytes with different types cannot collide.
      const key = createHash('sha256').update(data).update('\0' + contentType).digest('hex').slice(0, 32);
      manifest['/' + name] = key;
      assets.set(key, { key, value: data.toString('base64'), metadata: { contentType }, base64: true });
    } else throw new Error(`Unsupported build entry: ${path}`);
  }
}
await walk(root);
if (!manifest['/index.html'] || Object.keys(manifest).length > 20000) throw new Error('Expected index.html and at most 20,000 assets');
async function api(path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/pages/assets/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`Pages ${path} failed (HTTP ${response.status}): ${JSON.stringify(result.errors)}`);
  return result.result;
}
const hashes = [...assets.keys()];
const missing = await api('check-missing', { hashes });
if (!Array.isArray(missing) || missing.some(key => !assets.has(key))) throw new Error('Unexpected missing-assets response');
let batch = [], bytes = 0;
for (const key of missing) {
  const item = assets.get(key);
  const size = Buffer.byteLength(JSON.stringify(item));
  if (size > 45 * 1024 * 1024) throw new Error('Encoded asset is too large for a batch');
  if (batch.length && (bytes + size > 5 * 1024 * 1024 || batch.length === 100)) { await api('upload', batch); batch = []; bytes = 0; }
  batch.push(item); bytes += size;
}
if (batch.length) await api('upload', batch);
await api('upsert-hashes', { hashes });
await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
console.log(`Uploaded ${missing.length} missing assets; manifest contains ${Object.keys(manifest).length} files.`);
