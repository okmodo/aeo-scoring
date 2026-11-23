import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createAuditResultStore } from './audit-check-results.mjs';
import { presentRubricV3 } from './rubric-presentation.mjs';
import { scoreReference } from '../scripts/scoring-foundations.mjs';
import rubric from '../config/rubric.v3.mjs';

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

function fixtureStore(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(query) {
      const statement = sql.prepare(query);
      return { bind(...values) {
        const args = Object.fromEntries(values.map((value, index) => [String(index + 1), value]));
        return {
          first: async () => statement.get(args),
          all: async () => ({ results: statement.all(args) }),
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
  return {sql,store:createAuditResultStore(db)};
}

test('the D1 batch rolls back all result state on a write failure and rejects stale owners', async t => {
  const {sql,store}=fixtureStore(t);
  sql.exec(`
    INSERT INTO audits (id, url, cache_key, status, created_at, expires_at)
    VALUES ('audit', 'https://example.com', 'cache-key', 'pending', 1, 1000);
    INSERT INTO audit_queue_jobs (audit_id, phase, sequence, state, owner, lease_until, updated_at, expires_at)
    VALUES ('audit', 'assess', 2, 'terminalizing', 'current-owner', 100, 2, 90);
    CREATE TRIGGER fixture_abort BEFORE INSERT ON audit_check_results
    WHEN NEW.component_id = 'S2.json-ld' BEGIN SELECT RAISE(ABORT, 'result write failed'); END;
  `);
  const report = { status: 'incomplete', rubricVersion: rubric.version,
    criteria: rubric.criteria.map(group => ({ pillar: group.pillar, subchecks: [{ status: 'not_measured',
      components: group.subchecks.map(({ id }) => ({ id, status: 'not_measured' })),
    }] })) };
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
  const publish = async () => {
    assert.equal(await store.publish('audit', { now: 5, sequence: 2, owner: 'current-owner', terminalizing: true }), true);
    const report = JSON.parse(sql.prepare('SELECT report_json FROM audits').get().report_json);
    sql.exec("UPDATE audits SET status='pending', report_json=NULL WHERE id='audit'");
    return report;
  };
  let published = await publish();
  assert.equal(published.score, null);
  assert.equal(published.scoreBasis, 'earned_points');
  const zeroComponent = { id: 'S1.delivery', status: 'measured', fraction: 0, points: 0 };
  sql.prepare('UPDATE audit_check_results SET result_json=? WHERE component_id=?').run(JSON.stringify(zeroComponent), zeroComponent.id);
  published = await publish();
  assert.deepEqual(published.score, { total:0, structure:0, content:0 });
});

test('completed reports preserve the existing evidenced exclusion redistribution through D1', async t => {
  const {sql,store}=fixtureStore(t);
  const url='https://example.com';
  const checks=Object.fromEntries(rubric.criteria.flatMap(criterion=>criterion.subchecks)
    .map(({id})=>[id,{status:'measured',fraction:1}]));
  checks['S1.configuration']={status:'not_applicable',rule:'single_configuration',
    evidence:'e1',url,location:'initial product region',justification:'There is one configuration and no dependent values.'};
  const categories={categories:[{id:'fixture'}]};
  const reference=scoreReference(rubric,categories,{category:'fixture',checks});
  const report=presentRubricV3({status:reference.status,rubricVersion:rubric.version,score:null,coverage:{},fixes:[],
    criteria:rubric.criteria.map(criterion=>({...criterion,complete:reference.criteria[criterion.id].complete,
      subchecks:criterion.subchecks.map(({id,maxPoints})=>{
        const {status,fraction}=checks[id];
        const availablePoints=status==='not_applicable' ? 0 : maxPoints*criterion.maxPoints/reference.criteria[criterion.id].denominator;
        return {id,maxPoints,availablePoints,status,fraction:fraction??null,points:status==='measured'?availablePoints*fraction:null,evidenceIds:[]};
      }),
    })),
  });
  sql.exec(`
    INSERT INTO audits (id,url,cache_key,status,created_at,expires_at) VALUES ('complete','https://example.com','key','pending',1,1000);
    INSERT INTO audit_queue_jobs (audit_id,phase,sequence,state,owner,lease_until,updated_at,expires_at)
    VALUES ('complete','assess',2,'terminalizing','owner',100,2,90);
  `);
  const lease={owner:'owner',sequence:2,terminalizing:true};
  assert.equal(report.status,'complete');
  assert.equal(await store.stage('complete',{...lease,report,assessedUrl:url,now:3}),true);
  assert.equal(await store.publish('complete',{...lease,now:4}),true);
  const published=JSON.parse(sql.prepare('SELECT report_json FROM audits').get().report_json);
  assert.deepEqual(published.score,{total:100,structure:40,content:60});
  assert.equal(published.earnedPoints,100);
  const components=published.criteria.flatMap(criterion=>criterion.subchecks.flatMap(check=>check.components));
  const delivery=components.find(component=>component.id==='S1.delivery');
  assert.ok(delivery.points>delivery.maxPoints);
  const row=sql.prepare("SELECT result_json FROM audit_check_results WHERE component_id='S1.delivery'").get();
  assert.deepEqual(delivery,JSON.parse(row.result_json));
});
