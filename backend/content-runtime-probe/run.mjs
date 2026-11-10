// PROBE_SECRET stays in the environment and never appears in URLs or output.
import { createHmac } from 'node:crypto';
const origin = process.env.PROBE_ORIGIN;
const secret = process.env.PROBE_SECRET;
if (!origin || !secret || secret.length < 32 || !/^https:\/\/[a-z0-9.-]+\.workers\.dev$/.test(origin)) throw new Error('Set PROBE_ORIGIN and a 32+ character PROBE_SECRET');
for (const mode of ['sync', 'background']) for (const item of ['complete', 'partial', 'injection', 'large', 'truncated']) {
  const path = `/${mode}/${item}`, timestamp = String(Date.now());
  const signature = createHmac('sha256', secret).update(`${timestamp}\nPOST\n${path}`).digest('hex');
  const response = await fetch(origin + path, { method: 'POST', headers: { 'x-probe-timestamp': timestamp, 'x-probe-signature': signature } });
  console.log(JSON.stringify({ path, status: response.status, ray: response.headers.get('cf-ray'), result: await response.text() }));
}
