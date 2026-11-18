// Account-wide estimates. Cloudflare does not expose a completeness watermark here.
const LIMIT = 1024 * 1024;
const WINDOW = 31 * 86400000;
const classA = new Set('ListBuckets PutBucket ListObjects PutObject CopyObject CompleteMultipartUpload CreateMultipartUpload LifecycleStorageTierTransition ListMultipartUploads UploadPart UploadPartCopy ListParts PutBucketEncryption PutBucketCors PutBucketLifecycleConfiguration'.split(' '));
const classB = new Set('HeadBucket HeadObject GetObject UsageSummary GetBucketEncryption GetBucketLocation GetBucketCors GetBucketLifecycleConfiguration'.split(' '));
const free = new Set('DeleteObject DeleteBucket AbortMultipartUpload'.split(' '));
function amount(n) {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw Error('invalid r2 amount');
  return n;
}
async function json(fetcher, url, token, body) {
  const controller = new AbortController();
  let timer;
  try {
    const work = async () => {
      const response = await fetcher(url, { method: body ? 'POST' : 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok || !response.body?.getReader) throw Error('r2 response unavailable');
      const reader = response.body.getReader(), chunks = []; let size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > LIMIT) { void reader.cancel(); throw Error('r2 response too large'); } chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    };
    return await Promise.race([work(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('r2 timeout')); }, 10000); })]);
  } finally { clearTimeout(timer); }
}
export async function collectR2Usage({accountId, token, fetch: fetcher = (url, options) => globalThis.fetch(url, options), now = Date.now()} = {}) {
  if (!/^[0-9a-f]{32}$/.test(accountId ?? '') || typeof token !== 'string' || !token.trim() || typeof fetcher !== 'function' || !Number.isSafeInteger(now) || now < WINDOW) throw Error('invalid r2 configuration');
  const base = 'https://api.cloudflare.com/client/v4';
  const start = new Date(now - WINDOW).toISOString(), end = new Date(now).toISOString();
  const query = `query { viewer { accounts(filter:{accountTag:${JSON.stringify(accountId)}}) { r2OperationsAdaptiveGroups(limit:10000,filter:{datetime_geq:${JSON.stringify(start)},datetime_lt:${JSON.stringify(end)}}) { dimensions { actionType } sum { requests } } r2StorageAdaptiveGroups(limit:10000,filter:{datetime_geq:${JSON.stringify(start)},datetime_lt:${JSON.stringify(end)}}) { dimensions { bucketName } max { payloadSize metadataSize } } } } }`;
  const [metrics, analytics] = await Promise.all([json(fetcher, `${base}/accounts/${accountId}/r2/metrics`, token), json(fetcher, `${base}/graphql`, token, {query})]);
  if (metrics?.success !== true || !metrics.result || !Array.isArray(metrics.errors) || metrics.errors.length) throw Error('invalid r2 metrics');
  // Require each reported component rather than treating absent data as zero.
  let storage = 0;
  for (const state of ['published', 'uploaded']) {
    const part = metrics.result.standard?.[state];
    storage += amount(part?.payloadSize) + amount(part?.metadataSize);
  }
  if (!Number.isSafeInteger(storage)) throw Error('r2 overflow');
  if (analytics?.errors?.length || !Array.isArray(analytics?.data?.viewer?.accounts) || analytics.data.viewer.accounts.length !== 1) throw Error('invalid r2 analytics');
  const account = analytics.data.viewer.accounts[0];
  const historical = account?.r2StorageAdaptiveGroups;
  if (!Array.isArray(historical) || historical.length >= 10000) throw Error('invalid r2 historical storage');
  let peaks = 0;
  for (const row of historical) {
    if (typeof row?.dimensions?.bucketName !== 'string' || !row.dimensions.bucketName) throw Error('invalid r2 bucket');
    peaks += amount(row?.max?.payloadSize) + amount(row?.max?.metadataSize);
    if (!Number.isSafeInteger(peaks)) throw Error('r2 overflow');
  }
  storage = Math.max(storage, peaks);
  const rows = account?.r2OperationsAdaptiveGroups;
  if (!Array.isArray(rows) || rows.length >= 10000) throw Error('invalid r2 operations');
  let a = 0, b = 0;
  for (const row of rows) {
    const type = row?.dimensions?.actionType, n = amount(row?.sum?.requests);
    if (typeof type !== 'string' || !type) throw Error('invalid r2 operation');
    if (classA.has(type)) a += n; else if (classB.has(type)) b += n; else if (!free.has(type)) { a += n; b += n; }
  }
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) throw Error('r2 overflow');
  return {observedAt:now, r2StorageBytes:storage, r2ClassA:a, r2ClassB:b};
}
