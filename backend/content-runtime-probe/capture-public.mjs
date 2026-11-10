// Capture private bounded excerpts to a new 0600 file outside the repository.
import { createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const { PROBE_ORIGIN: origin, PROBE_SECRET: secret, PROBE_PRIVATE_OUTPUT: output } = process.env;
if (!/^https:\/\/[a-z0-9.-]+\.workers\.dev$/.test(origin || '') || !secret || secret.length < 32 || !/^\/private\/tmp\/aeo-[a-z0-9-]+\.json$/.test(output || '')) throw new Error('Set origin, secret and a new /private/tmp/aeo-*.json output');
const path = '/sync/kokatat', timestamp = String(Date.now());
const signature = createHmac('sha256', secret).update(`${timestamp}\nPOST\n${path}`).digest('hex');
const response = await fetch(origin + path, { method: 'POST', headers: { 'x-probe-timestamp': timestamp, 'x-probe-signature': signature } });
if (!response.ok) throw new Error(`Probe returned HTTP ${response.status}; ray ${response.headers.get('cf-ray')}`);
const data = await response.text();
await writeFile(output, data, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ output, status: response.status, ray: response.headers.get('cf-ray'), bytes: Buffer.byteLength(data) }));
