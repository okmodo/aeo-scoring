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
  report.criteria = [{ id: 'C2', pillar: 'content', maxPoints: 20, points: 3, complete: false, subchecks: [
    { id: 'C2.essential', maxPoints: 14, availablePoints: 12, status: 'measured', fraction: 0.25, points: 3, evidenceIds: ['real', 'missing'], reason: 'Partial' },
    { id: 'C2.supporting', maxPoints: 6, status: 'not_applicable', fraction: null, points: null, evidenceIds: [], reason: 'Excluded by rule', exclusion: 'Rule' },
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
  assert.equal(model.fixes[0].checks[0].availablePoints, 12)
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
    assert.match(render(pending), /Assessment in progress/)
    assert.match(render(pending), /report will update/)
    const failed = fixture('retrieval-failure')
    assert.match(render(failed), /Unable to assess/)
    assert.match(render(failed), /Final score and findings are unavailable/)
    const complete = fixture('assessment-complete')
    const syntheticHtml = render(complete)
    assert.match(syntheticHtml, /Report unavailable/)
    assert.doesNotMatch(syntheticHtml, /View score &amp; rubric|Northstar|Returned actions/)
    complete.report.evidence.forEach(source => { source.method = 'raw' })
    const html = render(complete)
    assert.match(html, /View score &amp; rubric/)
    assert.match(html, /ASSESSMENT COVERAGE/)
    assert.doesNotMatch(html, /Northstar|Fictional product|TEST DATA/)
    const partial = fixture('assessment-incomplete')
    partial.cache = { hit: true, validUntil: '2026-11-10T12:00:00Z' }
    partial.report.score = complete.report.score
    partial.report.criteria = [{ id: 'C2', pillar: 'content', maxPoints: 14, points: 3, complete: false, subchecks: [{ id: 'C2.essential', maxPoints: 14, availablePoints: 12, status: 'measured', fraction: 0.25, points: 3, evidenceIds: ['real'], reason: null }] }]
    partial.report.evidence = [{ id: 'real', url: 'javascript:alert(1)', method: 'raw', kind: 'source_excerpt', observedAt: '2026-11-09T12:00:00Z', location: 'body', excerpt: '<script>bad</script>' }]
    partial.report.fixes = [{ id: 'fix', title: 'Verify real details', owner: 'Merchant', checkIds: ['C2.essential'], evidenceIds: ['real'], recoverablePoints: 2, condition: 'Publish verified details.' }]
    const partialHtml = render(partial)
    assert.match(partialHtml, /Verify real details/)
    assert.match(partialHtml, /Publish verified details/)
    assert.match(partialHtml, /3 of 12 points awarded/)
    assert.match(partialHtml, /&lt;script&gt;bad&lt;\/script&gt;/)
    assert.doesNotMatch(partialHtml, /<script>bad<\/script>|href="javascript:/)
    assert.match(partialHtml, /Cached result/)
    assert.match(partialHtml, /Final score unavailable/)
    assert.doesNotMatch(partialHtml, /View score &amp; rubric/)
  } finally { await vite.close() }
})
