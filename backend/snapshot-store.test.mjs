import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotStore, MAX_HTML_BYTES, MAX_RENDERED_HTML_BYTES, SNAPSHOT_TTL_MS } from './snapshot-store.mjs';

function fixture() {
  let clock = 1000, deny = false, failPut = false, failArtifact = false;
  const rows = new Map(), objects = new Map(), reservations = [];
  const db = { prepare(sql) { return { bind(...a) { return {
    async first() { return rows.get(a[0]) || null; },
    async all() { return { results: [...rows.values()].filter(r => r.expires_at <= a[0]).slice(0, a[1]) }; },
    async run() {
      if (sql.startsWith('INSERT')) { if (rows.has(a[0])) return {meta:{changes:0}}; rows.set(a[0], { audit_id:a[0], object_prefix:a[1], created_at:a[2], expires_at:a[3], state:'pending' }); }
      else if (sql.includes("SET profile_state = 'pending'") || sql.includes("SET facts_state = 'pending'") || sql.includes("SET inputs_state = 'pending'")) {
        const kind = sql.includes('profile_state') ? 'profile' : sql.includes('facts_state') ? 'facts' : 'inputs', record = rows.get(a[0]);
        if (!record || record[`${kind}_state`] || record.expires_at <= a[2]) return {meta:{changes:0}};
        record[`${kind}_state`] = 'pending';
      } else if (sql.includes("SET profile_state = 'ready'") || sql.includes("SET facts_state = 'ready'") || sql.includes("SET inputs_state = 'ready'")) {
        const kind = sql.includes('profile_state') ? 'profile' : sql.includes('facts_state') ? 'facts' : 'inputs', record = rows.get(a[0]);
        if (!record || record[`${kind}_state`] !== 'pending' || record.expires_at <= a[4]) return {meta:{changes:0}};
        Object.assign(record, {[`${kind}_state`]:'ready',[`${kind}_size`]:a[2],[`${kind}_hash`]:a[3]});
      } else if (sql.startsWith('UPDATE')) Object.assign(rows.get(a[0]), {state:'ready',html_size:a[2],html_hash:a[3],snapshot_size:a[4],snapshot_hash:a[5]});
      else if (sql.startsWith('DELETE')) rows.delete(a[0]);
      return {meta:{changes:1}};
    },
  }; } }; } };
  const bucket = {
    async put(key, bytes) { if ((failPut && key.endsWith('/snapshot')) || (failArtifact && key.endsWith('/facts'))) throw Error('private data'); objects.set(key, bytes.slice()); },
    async get(key) { const bytes = objects.get(key); return bytes && {size:bytes.length, body:new Response(bytes).body}; },
    async delete(keys) { for (const key of keys) objects.delete(key); },
  };
  const allowance = { async reserve(args) { reservations.push(args); return {accepted:!deny,duplicate:false}; }, async settle() { return {accepted:true}; } };
  return { store:createSnapshotStore({db,bucket,allowance,now:()=>clock}), rows, objects, reservations,
    advance(ms) { clock += ms; }, deny() { deny = true; }, failPut() { failPut = true; }, failArtifact() { failArtifact = true; } };
}
const input = {auditId:'d9428888-122b-4c77-8d11-666666666666', snapshot:{url:'https://example.com'}, extracted:{title:'Test'}, rawHtml:new TextEncoder().encode('<p>test</p>')};

test('retains and verifies both bounded objects, expires exactly at 24 hours and cleans idempotently', async () => {
  const f = fixture(); await f.store.preserve(input);
  const result = await f.store.read(input.auditId);
  assert.deepEqual(result.extracted, input.extracted);
  assert.deepEqual(result.rawHtml, input.rawHtml);
  assert.equal(f.reservations.length, 2);
  f.advance(SNAPSHOT_TTL_MS);
  await assert.rejects(f.store.read(input.auditId), {code:'snapshot_expired'});
  assert.deepEqual(await f.store.cleanup(), {deleted:1});
  assert.deepEqual(await f.store.cleanup(), {deleted:0});
  assert.equal(f.objects.size, 0);
});
test('partial writes remain indexed for cleanup and duplicate writers cannot replace them', async () => {
  const f = fixture(); f.failPut();
  await assert.rejects(f.store.preserve(input), {code:'snapshot_unavailable'});
  assert.equal(f.rows.get(input.auditId).state, 'pending');
  await assert.rejects(f.store.preserve(input), {code:'snapshot_exists'});
  f.advance(SNAPSHOT_TTL_MS); await f.store.cleanup();
  assert.equal(f.objects.size, 0);
});
test('corruption, oversized input and denied admission fail closed', async () => {
  const f = fixture();
  await assert.rejects(f.store.preserve({...input,rawHtml:new Uint8Array(MAX_HTML_BYTES+1)}), {code:'snapshot_oversize'});
  await f.store.preserve(input);
  const key = [...f.objects.keys()].find(k => k.endsWith('/snapshot'));
  f.objects.get(key)[0] ^= 1;
  await assert.rejects(f.store.read(input.auditId), {code:'snapshot_corrupt'});
  f.deny();
  await f.store.delete(input.auditId);
  assert.equal(f.rows.size, 0);
});

test('metadata excludes transient bodies and missing objects fail closed', async () => {
  const f = fixture();
  await f.store.preserve({...input, snapshot:{...input.snapshot, rawHtml:input.rawHtml, extracted:input.extracted, body:'transient'}});
  const stored = await f.store.read(input.auditId);
  assert.deepEqual(stored.snapshot, input.snapshot);
  f.objects.delete([...f.objects.keys()].find(k => k.endsWith('/html')));
  await assert.rejects(f.store.read(input.auditId), {code:'snapshot_corrupt'});
});
test('rejects untrusted audit identifiers before writing', async () => {
  const f = fixture();
  await assert.rejects(f.store.preserve({...input,auditId:'../other'}), {code:'snapshot_invalid'});
  assert.equal(f.objects.size, 0);
  assert.equal(f.reservations.length, 0);
});

test('cleanup cannot delete keys outside a manifest audit prefix', async () => {
  const f = fixture(); await f.store.preserve(input);
  f.rows.get(input.auditId).object_prefix = 'unrelated/object';
  f.advance(SNAPSHOT_TTL_MS);
  await assert.rejects(f.store.cleanup(), {code:'snapshot_corrupt'});
  assert.equal(f.objects.size, 2);
});

test('profile and facts are independently persisted, immutable and expire with snapshot', async () => {
  const f = fixture(); await f.store.preserve(input);
  const profile = { category:'shorts', slots:['fit','material'] }, facts = { findings:[{id:'fit',value:'regular'}] };
  await f.store.saveAssessment({auditId:input.auditId,artifact:profile,kind:'profile'});
  await f.store.saveAssessment({auditId:input.auditId,artifact:facts,kind:'facts'});
  assert.deepEqual(await f.store.readAssessment(input.auditId,'profile'), profile);
  assert.deepEqual(await f.store.readAssessment(input.auditId), facts);
  await assert.rejects(f.store.saveAssessment({auditId:input.auditId,artifact:facts,kind:'facts'}), {code:'snapshot_exists'});
  f.advance(SNAPSHOT_TTL_MS);
  await assert.rejects(f.store.readAssessment(input.auditId), {code:'snapshot_expired'});
  await f.store.cleanup(); assert.equal(f.objects.size,0);
});
test('assessment partial writes are not readable or replaceable and are cleaned', async () => {
  const f = fixture(); await f.store.preserve(input); f.failArtifact();
  await assert.rejects(f.store.saveAssessment({auditId:input.auditId,artifact:{ok:true},kind:'facts'}), {code:'snapshot_unavailable'});
  assert.equal(f.rows.get(input.auditId).facts_state,'pending');
  await assert.rejects(f.store.readAssessment(input.auditId), {code:'snapshot_unavailable'});
  await assert.rejects(f.store.saveAssessment({auditId:input.auditId,artifact:{ok:true},kind:'facts'}), {code:'snapshot_exists'});
  f.advance(SNAPSHOT_TTL_MS); await f.store.cleanup(); assert.equal(f.objects.size,0);
});
test('assessment rejects oversized, malformed and corrupt artifacts', async () => {
  const f = fixture(); await f.store.preserve(input);
  await assert.rejects(f.store.saveAssessment({auditId:input.auditId,artifact:{v:'a'.repeat(32768)},kind:'profile'}), {code:'snapshot_oversize'});
  await assert.rejects(f.store.saveAssessment({auditId:input.auditId,artifact:{},kind:'__proto__'}), {code:'snapshot_invalid'});
  await f.store.saveAssessment({auditId:input.auditId,artifact:{answer:'yes'},kind:'facts'});
  f.objects.get([...f.objects.keys()].find(k=>k.endsWith('/facts')))[0] ^= 1;
  await assert.rejects(f.store.readAssessment(input.auditId), {code:'snapshot_corrupt'});
});


test('rendered content retains full bytes and only its provenance permits the larger limit', async () => {
  const f = fixture(), html = new Uint8Array(MAX_HTML_BYTES + 1).fill(65);
  await assert.rejects(f.store.preserve({...input, rawHtml:html}), {code:'snapshot_oversize'});
  await assert.rejects(f.store.preserve({...input, snapshot:{retrievalMethod:'browser_api_content'}, rawHtml:new Uint8Array(MAX_RENDERED_HTML_BYTES + 1)}), {code:'snapshot_oversize'});
  await f.store.preserve({...input, snapshot:{retrievalMethod:'browser_api_content'}, rawHtml:html});
  assert.deepEqual((await f.store.read(input.auditId)).rawHtml, html);
  const record = f.rows.get(input.auditId);
  const key = [...f.objects.keys()].find(k => k.endsWith('/snapshot'));
  const bytes = new TextEncoder().encode(JSON.stringify({snapshot:{retrievalMethod:'legacy'},extracted:input.extracted}));
  f.objects.set(key, bytes); record.snapshot_size = bytes.length;
  record.snapshot_hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
  await assert.rejects(f.store.read(input.auditId), {code:'snapshot_corrupt'});
});

test('inputs are bounded, immutable, integrity checked, and expire with capture', async () => {
  const f = fixture(); await f.store.preserve(input);
  const artifact = {version:'1',snapshot:input.snapshot,extracted:input.extracted};
  await assert.rejects(f.store.saveAssessment({auditId:input.auditId,kind:'inputs',artifact:{data:'x'.repeat(512*1024)}}), {code:'snapshot_oversize'});
  await f.store.saveAssessment({auditId:input.auditId,kind:'inputs',artifact});
  assert.deepEqual(await f.store.readAssessment(input.auditId,'inputs'), artifact);
  await assert.rejects(f.store.saveAssessment({auditId:input.auditId,kind:'inputs',artifact}), {code:'snapshot_exists'});
  const bytes = f.objects.get([...f.objects.keys()].find(k => k.endsWith('/inputs'))); bytes[0] ^= 1;
  await assert.rejects(f.store.readAssessment(input.auditId,'inputs'), {code:'snapshot_corrupt'});
  f.advance(SNAPSHOT_TTL_MS);
  await assert.rejects(f.store.readAssessment(input.auditId,'inputs'), {code:'snapshot_expired'});
  await f.store.cleanup(); assert.equal(f.objects.size,0);
});
