// R2 objects are private bindings. D1 owns their lifecycle and association to audits.
export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_HTML_BYTES = 1024 * 1024;
export const MAX_RENDERED_HTML_BYTES = 8 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const MAX_ASSESSMENT_BYTES = 256 * 1024;
const artifactLimits = Object.freeze({ profile: 32 * 1024, facts: MAX_ASSESSMENT_BYTES, inputs: 512 * 1024, prepared: 8 * 1024 * 1024 });
const encoder = new TextEncoder();
const fail = code => Object.assign(new Error('Retained snapshot unavailable'), { code });
const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
async function digest(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function time(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - SNAPSHOT_TTL_MS) throw fail('snapshot_invalid');
  return value;
}
async function readBounded(object, size) {
  if (!object.body?.getReader) throw fail('snapshot_corrupt');
  const reader = object.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > size) throw fail('snapshot_corrupt');
      chunks.push(part.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  if (total !== size) throw fail('snapshot_corrupt');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return encoder.encode(value);
  throw fail('snapshot_invalid');
}

export function createSnapshotStore({ db, bucket, allowance, now = Date.now }) {
  if (!db?.prepare || !bucket?.put || !bucket?.get || !bucket?.delete || !allowance?.reserve || !allowance?.settle) throw fail('snapshot_unavailable');
  async function guarded(costs, work) {
    const id = `snapshot-${crypto.randomUUID()}`;
    let reservation;
    try { reservation = await allowance.reserve({ id, costs, now: time(now) }); } catch { throw fail('snapshot_admission'); }
    if (!reservation?.accepted || reservation.duplicate) throw fail('snapshot_admission');
    const result = await work(); // Failed or uncertain work remains reserved.
    try { const settled = await allowance.settle({ id, now: time(now) }); if (!settled?.accepted) throw fail('snapshot_unavailable'); } catch { throw fail('snapshot_unavailable'); }
    return result;
  }
  async function row(id) {
    if (!validId(id)) throw fail('snapshot_invalid');
    return db.prepare('SELECT * FROM retained_snapshots WHERE audit_id = ?1').bind(id).first();
  }
  function validRecord(record) {
    if (!validId(record?.audit_id)) return false;
    const prefix = `retained/${record.audit_id}/`;
    return typeof record.object_prefix === 'string' && record.object_prefix.startsWith(prefix) && validId(record.object_prefix.slice(prefix.length));
  }
  async function remove(record) {
    if (!validRecord(record)) throw fail('snapshot_corrupt');
    // R2 DeleteObject is free; caller still admits Workers and D1 costs.
    // Keep the reference until both deletes succeed; repeating either delete is safe.
    await bucket.delete([`${record.object_prefix}/html`, `${record.object_prefix}/snapshot`, `${record.object_prefix}/profile`, `${record.object_prefix}/facts`, `${record.object_prefix}/inputs`, `${record.object_prefix}/prepared`]);
    await db.prepare('DELETE FROM retained_snapshots WHERE audit_id = ?1 AND object_prefix = ?2').bind(record.audit_id, record.object_prefix).run();
  }
  return {
    async preserve({ auditId, snapshot, extracted, rawHtml }) {
      if (!validId(auditId) || !snapshot || typeof snapshot !== 'object' || !extracted || typeof extracted !== 'object') throw fail('snapshot_invalid');
      const html = bytesOf(rawHtml);
      let json;
      const { rawHtml: ignoredRawHtml, extracted: ignoredExtracted, body: ignoredBody, ...metadata } = snapshot;
      try { json = encoder.encode(JSON.stringify({ snapshot: metadata, extracted })); } catch { throw fail('snapshot_invalid'); }
      if (html.byteLength > (metadata.retrievalMethod === 'browser_api_content' ? MAX_RENDERED_HTML_BYTES : MAX_HTML_BYTES) || json.byteLength > MAX_SNAPSHOT_BYTES) throw fail('snapshot_oversize');
      const created = time(now), prefix = `retained/${auditId}/${crypto.randomUUID()}`;
      const htmlHash = await digest(html), snapshotHash = await digest(json);
      await guarded({ r2StorageBytes: html.byteLength + json.byteLength, r2ClassA: 2, r2ClassB: 0 }, async () => {
      try {
        const inserted = await db.prepare("INSERT INTO retained_snapshots (audit_id, object_prefix, created_at, expires_at, state) VALUES (?1, ?2, ?3, ?4, 'pending') ON CONFLICT(audit_id) DO NOTHING").bind(auditId, prefix, created, created + SNAPSHOT_TTL_MS).run();
        if (inserted.meta.changes !== 1) throw fail('snapshot_exists');
        await bucket.put(`${prefix}/html`, html);
        await bucket.put(`${prefix}/snapshot`, json);
        const result = await db.prepare("UPDATE retained_snapshots SET state = 'ready', html_size = ?3, html_hash = ?4, snapshot_size = ?5, snapshot_hash = ?6 WHERE audit_id = ?1 AND object_prefix = ?2 AND state = 'pending'").bind(auditId, prefix, html.byteLength, htmlHash, json.byteLength, snapshotHash).run();
        if (result.meta.changes !== 1) throw fail('snapshot_unavailable');
      } catch (error) { if (error.code === 'snapshot_exists') throw error; throw fail('snapshot_unavailable'); }
      });
      return { auditId, expiresAt: created + SNAPSHOT_TTL_MS };
    },
    async read(auditId) {
      let record;
      try { record = await row(auditId); } catch (error) { if (error.code) throw error; throw fail('snapshot_unavailable'); }
      if (!record || record.state !== 'ready') throw fail('snapshot_unavailable');
      if (!validRecord(record) || record.audit_id !== auditId) throw fail('snapshot_corrupt');
      if (time(now) >= record.expires_at || time(now) < record.created_at) throw fail('snapshot_expired');
      if (record.expires_at !== record.created_at + SNAPSHOT_TTL_MS || !Number.isSafeInteger(record.html_size) || record.html_size < 0 || record.html_size > MAX_RENDERED_HTML_BYTES || !Number.isSafeInteger(record.snapshot_size) || record.snapshot_size < 0 || record.snapshot_size > MAX_SNAPSHOT_BYTES || !/^[a-f0-9]{64}$/.test(record.html_hash || '') || !/^[a-f0-9]{64}$/.test(record.snapshot_hash || '')) throw fail('snapshot_corrupt');
      return guarded({ r2StorageBytes: 0, r2ClassA: 0, r2ClassB: 2 }, async () => {
      try {
        const [htmlObject, jsonObject] = await Promise.all([bucket.get(`${record.object_prefix}/html`), bucket.get(`${record.object_prefix}/snapshot`)]);
        if (!htmlObject || !jsonObject || htmlObject.size !== record.html_size || jsonObject.size !== record.snapshot_size) throw fail('snapshot_corrupt');
        const [html, json] = await Promise.all([readBounded(htmlObject, record.html_size), readBounded(jsonObject, record.snapshot_size)]);
        if (html.byteLength !== record.html_size || json.byteLength !== record.snapshot_size || await digest(html) !== record.html_hash || await digest(json) !== record.snapshot_hash) throw fail('snapshot_corrupt');
        let parsed;
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)); } catch { throw fail('snapshot_corrupt'); }
        if (!parsed || typeof parsed.snapshot !== 'object' || !parsed.snapshot || typeof parsed.extracted !== 'object' || !parsed.extracted) throw fail('snapshot_corrupt');
        if (record.html_size > MAX_HTML_BYTES && parsed.snapshot.retrievalMethod !== 'browser_api_content') throw fail('snapshot_corrupt');
        if (time(now) >= record.expires_at) throw fail('snapshot_expired');
        return { ...parsed, rawHtml: new Uint8Array(html), source: { objectKey: `${record.object_prefix}/html`, sha256: record.html_hash, bytes: record.html_size, expiresAt: record.expires_at } };
      } catch (error) { if (error.code === 'snapshot_expired' || error.code === 'snapshot_corrupt') throw error; throw fail('snapshot_unavailable'); }
      });
    },
    async saveAssessment({ auditId, artifact, kind }) {
      if (!validId(auditId) || !Object.hasOwn(artifactLimits, kind) || !artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw fail('snapshot_invalid');
      let json;
      try { json = encoder.encode(JSON.stringify(artifact)); } catch { throw fail('snapshot_invalid'); }
      if (json.byteLength > artifactLimits[kind]) throw fail('snapshot_oversize');
      const record = await row(auditId);
      if (!record || record.state !== 'ready') throw fail('snapshot_unavailable');
      if (!validRecord(record) || record.audit_id !== auditId || record.expires_at !== record.created_at + SNAPSHOT_TTL_MS) throw fail('snapshot_corrupt');
      if (time(now) >= record.expires_at || time(now) < record.created_at) throw fail('snapshot_expired');
      const hash = await digest(json);
      await guarded({ r2StorageBytes: json.byteLength, r2ClassA: 1, r2ClassB: 0 }, async () => {
        try {
          const claimed = await db.prepare(`UPDATE retained_snapshots SET ${kind}_state = 'pending' WHERE audit_id = ?1 AND object_prefix = ?2 AND state = 'ready' AND ${kind}_state IS NULL AND expires_at > ?3 AND created_at <= ?3`).bind(auditId, record.object_prefix, time(now)).run();
          if (claimed.meta.changes !== 1) throw fail('snapshot_exists');
          await bucket.put(`${record.object_prefix}/${kind}`, json);
          const result = await db.prepare(`UPDATE retained_snapshots SET ${kind}_state = 'ready', ${kind}_size = ?3, ${kind}_hash = ?4 WHERE audit_id = ?1 AND object_prefix = ?2 AND ${kind}_state = 'pending' AND expires_at > ?5 AND created_at <= ?5`).bind(auditId, record.object_prefix, json.byteLength, hash, time(now)).run();
          if (result.meta.changes !== 1) throw fail('snapshot_unavailable');
        } catch (error) { if (error.code === 'snapshot_exists') throw error; throw fail('snapshot_unavailable'); }
      });
      return { auditId, expiresAt: record.expires_at };
    },
    async readAssessment(auditId, kind = 'facts') {
      if (!Object.hasOwn(artifactLimits, kind)) throw fail('snapshot_invalid');
      let record;
      try { record = await row(auditId); } catch (error) { if (error.code) throw error; throw fail('snapshot_unavailable'); }
      if (!record || record.state !== 'ready' || record[`${kind}_state`] !== 'ready') throw fail('snapshot_unavailable');
      if (!validRecord(record) || record.audit_id !== auditId || record.expires_at !== record.created_at + SNAPSHOT_TTL_MS || !Number.isSafeInteger(record[`${kind}_size`]) || record[`${kind}_size`] < 0 || record[`${kind}_size`] > artifactLimits[kind] || !/^[a-f0-9]{64}$/.test(record[`${kind}_hash`] || '')) throw fail('snapshot_corrupt');
      if (time(now) >= record.expires_at || time(now) < record.created_at) throw fail('snapshot_expired');
      return guarded({ r2StorageBytes: 0, r2ClassA: 0, r2ClassB: 1 }, async () => {
        try {
          const object = await bucket.get(`${record.object_prefix}/${kind}`);
          if (!object || object.size !== record[`${kind}_size`]) throw fail('snapshot_corrupt');
          const bytes = await readBounded(object, record[`${kind}_size`]);
          if (await digest(bytes) !== record[`${kind}_hash`]) throw fail('snapshot_corrupt');
          let artifact;
          try { artifact = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw fail('snapshot_corrupt'); }
          if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw fail('snapshot_corrupt');
          if (time(now) >= record.expires_at) throw fail('snapshot_expired');
          return artifact;
        } catch (error) { if (error.code === 'snapshot_expired' || error.code === 'snapshot_corrupt') throw error; throw fail('snapshot_unavailable'); }
      });
    },
    async delete(auditId) { const record = await row(auditId); if (record) await remove(record); },
    async cleanup({ limit = 100 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('snapshot_invalid');
      const records = await db.prepare('SELECT * FROM retained_snapshots WHERE expires_at <= ?1 ORDER BY expires_at LIMIT ?2').bind(time(now), limit).all();
      let deleted = 0;
      for (const record of records.results) { await remove(record); deleted++; }
      return { deleted };
    },
  };
}
