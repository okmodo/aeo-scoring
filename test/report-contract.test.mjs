import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getTestCopy, serializeReport, validateReport } from '../contracts/report-contract.mjs'
import { buildLiveReportModel } from '../src/live-report/model.ts'
import { scoreAudit } from '../backend/scoring.mjs'
import { extract } from '../backend/retrieval.mjs'
import { HtmlTestRewriter } from '../backend/html-product-test-helper.mjs'

const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url)))
const assessment = name => json(`./fixtures/report-fixtures/${name}.json`)
const checks = report => report.criteria.flatMap(criterion => criterion.subchecks)

test('versioned catalogs cover precisely the frozen rubric IDs and weights', () => {
  for (const version of ['1', '2']) {
    const rubric = json(`../config/rubric.v${version}.json`)
    const catalog = json(`../contracts/catalog.v${version}.json`)
    const ids = rubric.criteria.flatMap(criterion => criterion.subchecks.map(check => check.id))
    assert.equal(new Set(ids).size, ids.length)
    assert.deepEqual(Object.keys(catalog).sort(), ids.sort())
    for (const criterion of rubric.criteria) for (const check of criterion.subchecks) {
      const copy = getTestCopy(rubric.version, check.id)
      assert.ok(copy?.name && copy?.description && copy?.improve && copy?.fullCredit, check.id)
      assert.equal(copy.fullCredit, check.full, check.id)
    }
    assert.equal(getTestCopy(rubric.version, 'unknown.test'), null)
  }
})

test('frozen v2 and legacy reports round-trip through producer and consumer', () => {
  for (const input of [assessment('v2-complete'), assessment('v2-incomplete'), json('../contracts/v1/examples/assessment-complete.json')]) {
    input.report.evidence.forEach(item => { item.method = 'raw' })
    assert.equal(validateReport(input.report).valid, true)
    const report = serializeReport(input.report)
    assert.equal(report.contractVersion, '1.0.0')
    assert.deepEqual(checks(report).map(c => c.id), checks(input.report).map(c => c.id))
    for (const check of checks(report)) assert.deepEqual(check.presentation, getTestCopy(report.rubricVersion, check.id))
    const model = buildLiveReportModel({ ...input, report })
    assert.ok(model.report)
    assert.equal(model.checks.length, checks(report).length)
    assert.deepEqual(model.finalScore, input.report.status === 'complete' ? report.score : null)
  }
})

test('unsupported versions, unknown IDs and invalid numeric values fail closed', () => {
  for (const mutate of [
    r => { r.rubricVersion = '99.0.0' },
    r => { r.criteria[0].subchecks[0].id = 'S1.unknown' },
    r => { r.criteria[0].subchecks[0].fraction = 1.5 },
    r => { r.criteria[0].subchecks[0].points = -1 },
    r => { r.criteria[0].subchecks[0].points = NaN },
    r => { r.evidence[0] = null },
    r => { delete r.evidence[0].excerpt },
    r => { delete r.evidence[0].url },
    r => { delete r.evidence[0].id },
    r => { r.fixes = [{ id: 'bad', checkIds: null, evidenceIds: null }] },
    r => { delete r.coverage },
    r => { r.criteria = [] },
    r => { r.criteria[0].subchecks[0].reason = {} },
    r => { r.criteria[0].subchecks[0].exclusion = {} },
    r => { r.productName = {} },
    r => { r.variant = {} },
    r => { r.criteria[0].subchecks[0].presentation = { name: {} } },
    r => {
      for (const check of checks(r)) if (check.status === 'measured') { check.availablePoints = 0; check.points = 0 }
      r.score = { total: 0, structure: 0, content: 0 }
      r.earnedPoints = 0
    },
  ]) {
    const input = assessment('v2-complete')
    mutate(input.report)
    assert.equal(validateReport(input.report).valid, false)
    assert.throws(() => serializeReport(input.report), TypeError)
    const model = buildLiveReportModel(input)
    assert.equal(model.report, null)
    assert.equal(model.finalScore, null)
    assert.deepEqual(model.checks, [])
  }
})


test('consumer displays validated backend copy and falls back to catalog for legacy reports', () => {
  const input = assessment('v2-complete')
  input.report = serializeReport(input.report)
  input.report.criteria[0].subchecks[0].presentation.name = 'Product details available to AI tools'
  const model = buildLiveReportModel(input)
  assert.ok(model.report)
  assert.equal(model.checks[0].copy.name, 'Product details available to AI tools')
  delete input.report.criteria[0].subchecks[0].presentation
  assert.equal(buildLiveReportModel(input).checks[0].copy.name, getTestCopy('2.0.0', 'S1.delivery').name)
})

test('missing evidence references are surfaced without inventing evidence', () => {
  const input = assessment('v2-incomplete')
  input.report.criteria[0].subchecks[0].evidenceIds = ['missing']
  const model = buildLiveReportModel(input)
  assert.deepEqual(model.checks[0].missingEvidenceIds, ['missing'])
  assert.deepEqual(model.checks[0].evidence, [])
  assert.ok(model.warnings.length)
  assert.equal(model.finalScore, null)
})

test('backend scoring output serializes and is consumable by the frontend', async () => {
  const read = name => readFileSync(new URL(`../backend/fixtures/complete-engine/${name}`, import.meta.url), 'utf8')
  const snapshot = { url: 'https://shop.example/products/everyday-tshirt', observedAt: '2026-11-09T00:00:00.000Z', body: read('complete-shirt.html'), htmlLimited: null, ...JSON.parse(read('support.json')) }
  const extracted = await extract(snapshot, { HTMLRewriter: HtmlTestRewriter })
  const produced = serializeReport(scoreAudit(snapshot, extracted))
  const input = { ...assessment('v2-incomplete'), report: produced }
  const model = buildLiveReportModel(input)
  assert.ok(model.report)
  assert.equal(model.checks.length, checks(produced).length)
  assert.ok(model.checks.every(check => getTestCopy(produced.rubricVersion, check.id)))
})

test('serialized report matches independently frozen customer-facing metadata', () => {
  const frozen = assessment('v2-serialized')
  const actual = serializeReport(assessment('v2-complete').report)
  assert.deepEqual(actual, frozen.report)
})

test('legacy omitted available points use criterion redistribution and reject altered points', () => {
  const input = json('../contracts/v1/examples/assessment-incomplete.json')
  const criterion = input.report.criteria.find(c => c.id === 'C2')
  for (const check of criterion.subchecks) { check.status = 'measured'; check.fraction = 1; check.points = check.maxPoints; check.reason = null }
  const [first, ...rest] = criterion.subchecks
  const excluded = rest[0]
  excluded.status = 'not_applicable'
  excluded.fraction = null
  excluded.points = null
  excluded.reason = 'Excluded by established rule.'
  const denominator = criterion.subchecks.filter(c => c.status !== 'not_applicable').reduce((sum, c) => sum + c.maxPoints, 0)
  for (const check of criterion.subchecks) {
    delete check.availablePoints
    if (check.status === 'measured') check.points = check.fraction * check.maxPoints * criterion.maxPoints / denominator
  }
  assert.equal(validateReport(input.report).valid, true)
  const model = buildLiveReportModel(input)
  assert.equal(model.checks.find(c => c.id === first.id).availablePoints, first.maxPoints * criterion.maxPoints / denominator)
  assert.equal(model.checks.find(c => c.id === excluded.id).availablePoints, 0)
  first.points = 0
  assert.equal(validateReport(input.report).valid, false)
  assert.equal(buildLiveReportModel(input).report, null)
})

test('v3 frozen reports validate complete and unresolved component totals', async () => {
  const { availablePointsForCheck, RUBRIC_V3_GROUPS } = await import('../contracts/report-contract.mjs')
  const complete = json('./fixtures/customer-copy/complete.json').report
  const unresolved = json('./fixtures/customer-copy/assessment.json').report
  assert.equal(validateReport(complete).valid, true)
  assert.equal(validateReport(unresolved).valid, true)
  assert.equal(RUBRIC_V3_GROUPS.length, 7)
  const rows = checks(unresolved)
  assert.equal(rows.length, 24)
  assert.equal(rows.find(c => c.id === 'S1.readable-html').status, 'not_measured')
  assert.equal(rows.find(c => c.id === 'S1.readable-html').earnedPoints, 4)
  assert.equal(rows.find(c => c.id === 'S2.optional-claims').status, 'not_applicable')
  assert.equal(availablePointsForCheck(unresolved, 'S2.optional-claims'), 0)
  assert.equal(availablePointsForCheck(unresolved, 'S1.readable-html'), 7)
  for (const row of rows) {
    const copy = getTestCopy('3.0.0', row.id)
    assert.ok(copy?.name && copy.description && copy.improve && copy.fullCredit && copy.group && copy.type, row.id)
  }
  assert.equal(getTestCopy('3.0.0', 'S8.context'), null)
})

test('v3 rejects altered components, totals, completion and evidence shapes', async () => {
  const { availablePointsForCheck } = await import('../contracts/report-contract.mjs')
  for (const mutate of [
    r => { r.criteria[0].subchecks[0].components[0].points = -1 },
    r => { r.criteria[0].subchecks[0].availablePoints = 99 },
    r => { r.criteria[0].subchecks[0].earnedPoints = 99 },
    r => { r.criteria[0].subchecks[0].components[0].availablePoints = 0 },
    r => { r.criteria[0].subchecks[0].components[0].evidenceIds = null },
    r => { r.criteria[0].subchecks[0].evidenceIds = ['forged'] },
    r => { r.criteria[0].subchecks[0].components.pop() },
    r => { r.criteria[0].complete = true },
    r => { r.earnedPoints = 100 },
    r => { r.status = 'complete'; r.score = { total: 100, structure: 40, content: 60 } },
    r => { r.criteria[1].subchecks[4].components[0].availablePoints = 2 },
    r => { r.rubricVersion = '9.0.0' },
  ]) {
    const r = json('./fixtures/customer-copy/assessment.json').report
    mutate(r)
    assert.equal(validateReport(r).valid, false)
    assert.equal(availablePointsForCheck(r, 'S1.readable-html'), null)
    assert.throws(() => serializeReport(r), TypeError)
  }
})

test('v3 malformed evidence references and null components fail without throwing', () => {
  for (const value of ['x', null, { length: 1 }]) {
    const report = json('./fixtures/customer-copy/assessment.json').report
    report.criteria[0].subchecks[0].evidenceIds = value
    assert.doesNotThrow(() => validateReport(report))
    assert.equal(validateReport(report).valid, false)
  }
  const report = json('./fixtures/customer-copy/assessment.json').report
  report.criteria[0].subchecks[0].components[0] = null
  assert.doesNotThrow(() => validateReport(report))
  assert.equal(validateReport(report).valid, false)
})

test('v3 fixture envelope, score and coverage match the report', () => {
  for (const name of ['assessment', 'complete']) {
    const fixture = json(`./fixtures/customer-copy/${name}.json`)
    const report = fixture.report
    const rows = checks(report)
    assert.equal(fixture.status, report.status)
    assert.equal(report.score === null, report.status === 'incomplete')
    assert.equal(report.coverage.total, rows.length)
    assert.equal(report.coverage.measured, rows.filter(row => row.status === 'measured').length)
    assert.equal(report.coverage.notMeasured, rows.filter(row => row.status === 'not_measured').length)
    assert.equal(report.coverage.notApplicable, rows.filter(row => row.status === 'not_applicable').length)
  }
})
