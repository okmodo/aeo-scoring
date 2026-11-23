import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildLiveReportModel } from '../src/live-report/model.ts'

const fixture = name => JSON.parse(readFileSync(new URL(`../contracts/v1/examples/${name}.json`, import.meta.url)))

test('frozen complete and incomplete assessments retain only a valid final score', () => {
  const complete = fixture('assessment-complete')
  const withheld = buildLiveReportModel(complete)
  assert.equal(withheld.report, null)
  assert.equal(withheld.assessment.report, null)
  assert.deepEqual(withheld.fixes, [])
  assert.deepEqual(withheld.checks, [])
  assert.equal(withheld.finalScore, null)
  assert.match(withheld.warnings[0], /synthetic/)
  complete.report.evidence.forEach(item => { item.method = 'raw' })
  const model = buildLiveReportModel(complete)
  assert.deepEqual(model.finalScore, complete.report.score)
  assert.equal(Object.values(model.counts).reduce((a, b) => a + b, 0), model.checks.length)
  const incomplete = fixture('assessment-incomplete')
  incomplete.report.score = complete.report.score
  assert.equal(buildLiveReportModel(incomplete).finalScore, null)
  assert.equal(buildLiveReportModel(fixture('retrieval-failure')).fixes.length, 0)
})

test('backend actions preserve order, evidence and unknown recovery without inventing fields', () => {
  const assessment = fixture('assessment-incomplete')
  const report = assessment.report
  report.criteria = [{ id: 'C2', pillar: 'content', maxPoints: 20, points: 5, complete: false, subchecks: [
    { id: 'C2.essential', maxPoints: 14, availablePoints: 20, status: 'measured', fraction: 0.25, points: 5, evidenceIds: ['real', 'missing'], reason: 'Partial' },
    { id: 'C2.supporting', maxPoints: 6, status: 'not_applicable', fraction: null, points: null, evidenceIds: [], reason: 'Excluded by rule', exclusion: 'Rule' },
  ] }, { id: 'S1', pillar: 'structure', maxPoints: 13, points: 0, complete: false, subchecks: [
    { id: 'S1.price', maxPoints: 3, status: 'measured', fraction: 0, points: 0, evidenceIds: [], reason: null },
    { id: 'S1.identity', maxPoints: 2, status: 'not_measured', fraction: null, points: null, evidenceIds: [], reason: null },
  ] }]
  report.evidence = [
    { id: 'real', url: 'https://example.com', method: 'raw', kind: 'source_excerpt', observedAt: '', location: 'body', excerpt: '<script>untrusted</script>' },
  ]
  report.fixes = [
    { id: 'first', title: '<img onerror=alert(1)>', owner: 'merchant', checkIds: ['C2.essential'], evidenceIds: ['real', 'missing'], recoverablePoints: null, condition: 'Verify applicable attributes.' },
    { id: 'second', title: 'Review', owner: 'merchant', checkIds: ['C2.essential'], evidenceIds: [], recoverablePoints: 3, condition: 'Check the source.' },
  ]
  const model = buildLiveReportModel(assessment)
  assert.deepEqual(model.counts, { measured: 0, partial: 1, zero: 1, unmeasured: 1, excluded: 1 })
  assert.deepEqual(model.fixes.map(f => f.id), ['first', 'second'])
  assert.equal(model.fixes[0].recoverablePoints, null)
  assert.equal(model.fixes[0].checks[0].availablePoints, 20)
  assert.equal(model.fixes[0].checks[0].fullCredit, 'Every applicable essential attribute explicit with required units and scope')
  assert.equal(model.fixes[0].condition, 'Verify applicable attributes.')
  assert.deepEqual(model.fixes[0].missingEvidenceIds, ['missing'])
  assert.equal(model.fixes[0].evidence[0].excerpt, '<script>untrusted</script>')
  assert.equal(model.fixes[0].title, '<img onerror=alert(1)>')
  assert.ok(model.warnings.length)
  assert.equal(model.finalScore, null)
})

test('live report renders real state, actions, evidence and cache context safely', async () => {
  const { createServer } = await import('vite')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { LiveReport } = await vite.ssrLoadModule('/src/live-report/LiveReport.tsx')
    const render = assessment => renderToStaticMarkup(React.createElement(LiveReport, { assessment, onBack() {} }))
    const pending = fixture('assessment-incomplete')
    pending.status = 'pending'
    pending.report = null
    assert.match(render(pending), /Checking your product page/)
    assert.match(render(pending), /test results will appear/)
    const failed = fixture('retrieval-failure')
    assert.match(render(failed), /We couldn’t assess this page/)
    const complete = fixture('assessment-complete')
    const syntheticHtml = render(complete)
    assert.match(syntheticHtml, /Report unavailable/)
    assert.doesNotMatch(syntheticHtml, /View overall score|Northstar|Returned actions/)
    complete.report.evidence.forEach(source => { source.method = 'raw' })
    const html = render(complete)
    assert.match(html, /View overall score/)
    assert.match(html, /Your results at a glance/)
    assert.match(html, /class="rd-points-doughnut" role="img"/)
    assert.match(html, /aria-label="Total score:/)
    assert.doesNotMatch(html, /Northstar|Fictional product|TEST DATA/)
    const partial = fixture('assessment-incomplete')
    partial.cache = { hit: true, validUntil: '2026-11-10T12:00:00Z' }
    partial.report.criteria = [{ id: 'C2', pillar: 'content', maxPoints: 14, points: 3.5, complete: false, subchecks: [{ id: 'C2.essential', maxPoints: 14, availablePoints: 14, status: 'measured', fraction: 0.25, points: 3.5, evidenceIds: ['real'], reason: null }] }]
    partial.report.evidence = [{ id: 'real', url: 'javascript:alert(1)', method: 'raw', kind: 'source_excerpt', observedAt: '2026-11-09T12:00:00Z', location: 'body', excerpt: '<script>bad</script>' }]
    partial.report.fixes = [{ id: 'fix', title: 'Verify real details', owner: 'Merchant', checkIds: ['C2.essential'], evidenceIds: ['real'], recoverablePoints: 2, condition: 'Publish verified details.' }]
    const partialHtml = render(partial)
    assert.match(partialHtml, /Essential product details/)
    assert.match(partialHtml, /What we found/)
    assert.match(partialHtml, /3.5 of 14 available points earned/)
    assert.match(partialHtml, /&lt;script&gt;bad&lt;\/script&gt;/)
    assert.doesNotMatch(partialHtml, /<script>bad<\/script>|href="javascript:/)
    assert.match(partialHtml, /saved result/)
    assert.match(partialHtml, /overall score is unavailable/)
    assert.match(partialHtml, /aria-label="Points so far:/)
    assert.match(partialHtml, /Total score pending/)
    assert.doesNotMatch(partialHtml, /View overall score/)
  } finally { await vite.close() }
})


test('each supported rubric test has a unique business name and plain-language explanation', async () => {
  const { getTestCopy } = await import('../contracts/report-contract.mjs')
  for (const version of ['1', '2']) {
    const rubric = JSON.parse(readFileSync(new URL(`../config/rubric.v${version}.json`, import.meta.url)))
    const ids = rubric.criteria.flatMap(criterion => criterion.subchecks.map(check => check.id))
    const copy = ids.map(id => getTestCopy(rubric.version, id))
    assert.ok(copy.every(Boolean))
    assert.equal(new Set(copy.map(item => item.name)).size, ids.length)
    for (const item of copy) {
      assert.ok(item.description && item.improve)
      assert.doesNotMatch(item.name, /[SC][1-8]\.|assessment|subcheck/i)
    }
  }
})

test('test results preserve partial credit, effective weights and unavailable points', async () => {
  const { resultForTest, pointsForTest, formatPoints } = await import('../src/live-report/test-copy.ts')
  const check = { status: 'measured', fraction: 0.25, points: 3, maxPoints: 14, availablePoints: 12 }
  assert.equal(resultForTest(check), 'Fail')
  assert.deepEqual(pointsForTest(check), { earned: 3, missed: 9, available: 12 })
  assert.equal(resultForTest({ ...check, fraction: 1, points: 12 }), 'Pass')
  assert.equal(resultForTest({ ...check, fraction: 0, points: 0 }), 'Fail')
  for (const item of [
    { ...check, status: 'not_measured', points: null, fraction: null },
    { ...check, fraction: null },
    { ...check, points: null },
  ]) {
    assert.equal(resultForTest(item), 'Not completed')
    assert.equal(pointsForTest(item), null)
  }
  const excluded = { ...check, status: 'not_applicable', fraction: null, points: null }
  assert.equal(resultForTest(excluded), 'Not applicable')
  assert.equal(pointsForTest(excluded), null)
  assert.equal(formatPoints(0.6428571428571429), '0.64')
})

test('business report lists all tests and surfaces actual findings without the old instructional blocks', async () => {
  const { createServer } = await import('vite')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { LiveReport } = await vite.ssrLoadModule('/src/live-report/LiveReport.tsx')
    const assessment = fixture('assessment-incomplete')
    assessment.report.criteria = [{ id: 'S2', pillar: 'structure', maxPoints: 9, points: 2.5, complete: false, subchecks: [
      { id: 'S2.entity', status: 'measured', fraction: 1, points: 2, maxPoints: 2, evidenceIds: ['pass'], reason: null },
      { id: 'S2.offer', status: 'measured', fraction: 0.25, points: 0.5, maxPoints: 2, evidenceIds: ['offer', 'unsafe'], reason: null },
      { id: 'S2.identifiers', status: 'measured', fraction: 0, points: 0, maxPoints: 2, evidenceIds: [], reason: null },
      { id: 'S2.variants', status: 'not_measured', fraction: null, points: null, maxPoints: 1, evidenceIds: [], reason: 'Available evidence does not establish this check.' },
      { id: 'S2.core-properties', status: 'not_applicable', fraction: null, points: null, maxPoints: 2, evidenceIds: [], reason: 'Excluded for this product.' },
    ] }]
    assessment.report.evidence = [
      { id: 'pass', url: 'https://example.com/item', method: 'raw', kind: 'derived_observation', observedAt: '', location: 'product record', excerpt: 'A product record was found.' },
      { id: 'offer', url: 'https://example.com/item', method: 'raw', kind: 'derived_observation', observedAt: '', location: 'product record', excerpt: 'Product has no valid Offer.' },
      { id: 'unsafe', url: 'javascript:alert(1)', method: 'raw', kind: 'source_excerpt', observedAt: '', location: 'body', excerpt: '<img src=x onerror=alert(1)>' },
    ]
    assessment.report.fixes = []
    const html = renderToStaticMarkup(React.createElement(LiveReport, { assessment, onBack() {} }))
    assert.equal((html.match(/class="rd-test-button"/g) ?? []).length, 5)
    assert.match(html, /3 of 5 tests completed/)
    assert.match(html, /1 passed and 2 failed/)
    assert.match(html, /Not completed/)
    assert.match(html, /Not applicable/)
    assert.match(html, /Points unavailable/)
    assert.match(html, /Price and stock details for search tools/)
    assert.match(html, /No valid product offer was found/)
    assert.match(html, /0.5 of 2 available points earned/)
    assert.match(html, /Some requirements were met/)
    assert.match(html, /Audit finding/)
    assert.match(html, /From your website/)
    assert.match(html, /Earned <strong>\+0.5<\/strong>/)
    assert.match(html, /Missed <strong>−1.5<\/strong>/)
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
    assert.doesNotMatch(html, /<img src=x|href="javascript:/)
    assert.doesNotMatch(html, /<dt>|ASSESSMENT RULE|Overall action condition|Returned actions|CONDITIONAL OPPORTUNITY/)
    assert.doesNotMatch(html, /View overall score/)
    const complete = fixture('assessment-complete')
    complete.report.evidence.forEach(source => { source.method = 'raw' })
    complete.status = 'incomplete'
    complete.report.status = 'incomplete'
    complete.report.score = null
    complete.report.criteria[0].subchecks[0].status = 'not_measured'
    complete.report.criteria[0].subchecks[0].fraction = null
    complete.report.criteria[0].subchecks[0].points = null
    const incompletePoints = renderToStaticMarkup(React.createElement(LiveReport, { assessment: complete, onBack() {} }))
    assert.match(incompletePoints, /Not completed/)
    assert.doesNotMatch(incompletePoints, /View overall score/)
  } finally { await vite.close() }
})

test('doughnut points reconcile without inventing a final score for unfinished tests', async () => {
  const { summarizeTestPoints } = await import('../src/live-report/test-copy.ts')
  const checks = [
    { status: 'measured', fraction: 1, points: 20, maxPoints: 20 },
    { status: 'measured', fraction: 0.5, points: 10, maxPoints: 25, availablePoints: 20 },
    { status: 'not_measured', fraction: null, points: null, maxPoints: 60 },
  ]
  assert.deepEqual(summarizeTestPoints(checks, null), { earned: 30, missed: 10, unscored: 60, total: 100 })
  assert.deepEqual(summarizeTestPoints([], null), { earned: 0, missed: 0, unscored: 100, total: 100 })
  assert.deepEqual(summarizeTestPoints(checks, 78.125), { earned: 78.125, missed: 21.875, unscored: 0, total: 100 })
  const excluded = { status: 'not_applicable', points: null, fraction: null, maxPoints: 10 }
  assert.deepEqual(summarizeTestPoints([...checks, excluded], null), summarizeTestPoints(checks, null))
})

// Fictional deterministic observations: raw methods exercise the live-report guard,
// not a claim that a real merchant page was inspected.
test('v2 complete and unfinished reports render catalog names, points and score state', async () => {
  const { createServer } = await import('vite')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const { getTestCopy } = await import('../contracts/report-contract.mjs')
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { LiveReport } = await vite.ssrLoadModule('/src/live-report/LiveReport.tsx')
    const render = assessment => renderToStaticMarkup(React.createElement(LiveReport, { assessment, onBack() {} }))
    const load = name => JSON.parse(readFileSync(new URL(`./fixtures/report-fixtures/${name}.json`, import.meta.url)))
    const complete = load('v2-complete')
    const html = render(complete)
    for (const check of complete.report.criteria.flatMap(item => item.subchecks)) {
      assert.ok(html.includes(getTestCopy('2.0.0', check.id).name), check.id)
    }
    assert.doesNotMatch(html, /Additional website test/)
    assert.match(html, /View overall score/)
    assert.match(html, /100/)
    const presented = load('v2-serialized')
    presented.report.criteria[0].subchecks[0].presentation.name = 'Custom <product> test'
    const customHtml = render(presented)
    assert.match(customHtml, /Custom &lt;product&gt; test/)
    assert.doesNotMatch(customHtml, /Custom <product> test/)
    presented.report.criteria[0].subchecks[0].presentation.name = {}
    assert.match(render(presented), /Report unavailable/)
    const incomplete = load('v2-incomplete')
    incomplete.report.criteria[0].subchecks[0].reason = 'Observed invalid values: material=.'
    incomplete.report.evidence[0].kind = 'source_excerpt'
    incomplete.report.evidence[0].excerpt = 'Observed invalid values: material=.'
    const partial = render(incomplete)
    assert.match(partial, /Observed invalid values: material=\./)
    assert.match(partial, /The product’s material information was missing or could not be read as a valid value\./)

    assert.match(partial, /2 of 4 available points earned/)
    assert.match(partial, /Not completed/)
    assert.match(partial, /Not applicable/)
    assert.doesNotMatch(partial, /View overall score|Additional website test/)
    for (const mutate of [
      report => { report.rubricVersion = '99.0.0' },
      report => { report.criteria[0].subchecks[0].id = 'S1.invalid-secret' },
      report => { report.criteria[0].subchecks[0].points = -42 },
    ]) {
      const invalid = load('v2-complete')
      mutate(invalid.report)
      invalid.report.productName = 'SECRET_INVALID_REPORT_CONTENT'
      const rejected = render(invalid)
      assert.match(rejected, /Report unavailable/)
      assert.doesNotMatch(rejected, /SECRET_INVALID_REPORT_CONTENT|S1.invalid-secret|View overall score/)
    }
  } finally { await vite.close() }
})

import './customer-copy.test.mjs'
