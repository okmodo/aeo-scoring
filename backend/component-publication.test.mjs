import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('./migrations/0015-audit-check-results.sql', import.meta.url), 'utf8');

test('the migration preserves existing reports and cascades audit expiry to results', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE audits (id TEXT PRIMARY KEY, status TEXT NOT NULL, report_json TEXT);
    INSERT INTO audits VALUES ('old', 'complete', '{"score":42}');
  `);
  db.exec(migration);
  const old = db.prepare('SELECT status, report_json, checks_completed_at FROM audits WHERE id=?').get('old');
  assert.deepEqual({ ...old }, { status: 'complete', report_json: '{"score":42}', checks_completed_at: null });
  db.exec(`
    INSERT INTO audits (id, status) VALUES ('new', 'pending');
    INSERT INTO audit_result_outbox VALUES ('new', 3, 'incomplete', '{}', 'https://example.com', 1, 2, 'lease');
    INSERT INTO audit_check_results VALUES ('new', 'C1.explanation', '{"status":"measured","points":4}');
  `);
  assert.throws(() => db.exec(`INSERT INTO audit_check_results VALUES ('new', 'C1.explanation', '{}')`), /UNIQUE/);
  assert.throws(() => db.exec(`INSERT INTO audit_check_results VALUES ('missing', 'C1.explanation', '{}')`), /FOREIGN KEY/);
  db.exec("DELETE FROM audits WHERE id='new'");
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_result_outbox').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_check_results').get().n, 0);
});

test('the D1 batch rolls back all result state on a write failure and rejects stale owners', async t => {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const { createAuditResultStore } = await import('./audit-check-results.mjs');
  const { default: rubric } = await import('../config/rubric.v3.mjs');
  const db = {
    prepare(query) {
      const statement = sql.prepare(query);
      return { bind(...values) {
        const args = Object.fromEntries(values.map((value, index) => [String(index + 1), value]));
        return {
          first: async () => statement.get(args),
          run: async () => ({ meta: { changes: Number(statement.run(args).changes) } }),
        };
      } };
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
  sql.exec(`
    INSERT INTO audits (id, url, cache_key, status, created_at, expires_at)
    VALUES ('audit', 'https://example.com', 'cache-key', 'pending', 1, 1000);
    INSERT INTO audit_queue_jobs (audit_id, phase, sequence, state, owner, lease_until, updated_at, expires_at)
    VALUES ('audit', 'assess', 2, 'terminalizing', 'current-owner', 100, 2, 90);
    CREATE TRIGGER fixture_abort BEFORE INSERT ON audit_check_results
    WHEN NEW.component_id = 'S2.json-ld' BEGIN SELECT RAISE(ABORT, 'result write failed'); END;
  `);
  const report = { status: 'incomplete', rubricVersion: rubric.version,
    criteria: rubric.criteria.map(group => ({ subchecks: [{
      components: group.subchecks.map(({ id }) => ({ id, status: 'not_measured' })),
    }] })) };
  const store = createAuditResultStore(db);
  const stage = (owner, now = 3) => store.stage('audit', {
    report, owner, sequence: 2, now, assessedUrl: 'https://example.com', terminalizing: true,
  });
  assert.equal(await stage('stale-owner'), false);
  assert.equal(await stage('current-owner', 100), false);
  await assert.rejects(stage('current-owner'), /result write failed/);
  assert.equal(sql.prepare('SELECT checks_completed_at FROM audits').get().checks_completed_at, null);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM audit_result_outbox').get().n, 0);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM audit_check_results').get().n, 0);
  sql.exec('DROP TRIGGER fixture_abort');
  assert.equal(await stage('current-owner'), true);
  assert.equal(await stage('current-owner', 4), true);
  assert.equal(sql.prepare('SELECT checks_completed_at FROM audits').get().checks_completed_at, 3);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM audit_check_results').get().n, 39);
});
