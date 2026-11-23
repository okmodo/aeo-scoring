import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildLiveReportModel } from '../src/live-report/model.ts'

test('v3 retains row coverage, component evidence and verified subtotal', () => {
  const assessment = JSON.parse(readFileSync(new URL('../contracts/v1/examples/assessment-incomplete.json', import.meta.url)))
  assessment.report.rubricVersion = '3.0.0'
  assessment.report.evidence = [{ id:'e', url:'https://example.com', method:'raw', kind:'source_excerpt', observedAt:'', location:'body', excerpt:'Product' }]
  assessment.report.criteria = [{ id:'S2', pillar:'structure', maxPoints:2, points:1, complete:false, subchecks:[{
    id:'S2.product-markup', maxPoints:2, availablePoints:2, status:'not_measured', points:null, earnedPoints:1, fraction:null, reason:'Syntax unavailable', evidenceIds:['e'], components:[
      { id:'S2.json-ld', maxPoints:1, availablePoints:1, status:'measured', points:1, fraction:1, reason:null, evidenceIds:['e'] },
      { id:'S2.syntax', maxPoints:1, availablePoints:1, status:'not_measured', points:null, fraction:null, reason:'Syntax unavailable', evidenceIds:[] },
    ]
  }] }]
  assessment.report.fixes = []
  const model = buildLiveReportModel(assessment)
  assert.equal(model.counts.unmeasured, 1)
  assert.equal(model.checks.length, 1)
  assert.equal(model.checks[0].label, 'Product markup')
  assert.equal(model.checks[0].earnedPoints, 1)
  assert.equal(model.checks[0].components[0].label, 'Product JSON-LD')
  assert.equal(model.checks[0].components[0].evidence[0].id, 'e')
  assert.equal(model.checks[0].components[1].reason, 'Syntax unavailable')
  assert.equal(model.finalScore, null)
})

test('polling continues after checks complete and stops at terminal report', async () => {
  const { pollAudit, AUDIT_ORIGIN } = await import('../src/audit.ts')
  const assessment = JSON.parse(readFileSync(new URL('../contracts/v1/examples/assessment-incomplete.json', import.meta.url)))
  assessment.status = 'pending'; assessment.report = null
  assessment.statusUrl = '/api/v1/audits/abc-123'
  const staged = { ...assessment, checksCompletedAt:'2026-11-23T12:00:00Z' }
  const terminal = { ...staged, status:'incomplete' }
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    return new Response(JSON.stringify(requests.length === 1 ? staged : terminal), { status:200 })
  }
  try {
    const updates = []; const delays = []
    const result = await pollAudit(assessment, 'secret', new AbortController().signal, item => updates.push(item), async delay => { delays.push(delay) })
    assert.equal(result.status, 'incomplete')
    assert.deepEqual(updates.map(item => item.status), ['pending', 'incomplete'])
    assert.deepEqual(delays, [2000, 4000])
    assert.equal(requests.length, 2)
    assert.equal(requests[0].url, AUDIT_ORIGIN + assessment.statusUrl)
    assert.equal(requests[0].options.redirect, 'error')
    await pollAudit(terminal, 'secret', new AbortController().signal, () => assert.fail('terminal should not update'), async () => assert.fail('terminal should not wait'))
    assert.equal(requests.length, 2)
  } finally { globalThis.fetch = original }
})

test('staged and partial v3 report states render clearly', async () => {
  const { createServer } = await import('vite')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const vite = await createServer({ server:{ middlewareMode:true }, appType:'custom', logLevel:'silent' })
  try {
    const { LiveReport } = await vite.ssrLoadModule('/src/live-report/LiveReport.tsx')
    const assessment = JSON.parse(readFileSync(new URL('../contracts/v1/examples/assessment-incomplete.json', import.meta.url)))
    assessment.status = 'pending'; assessment.report = null; assessment.checksCompletedAt = '2026-11-23T12:00:00Z'
    assert.match(renderToStaticMarkup(React.createElement(LiveReport, {assessment, onBack() {}})), /Checks are complete.*preparing the report/)
    assessment.status = 'incomplete'
    assessment.report = { rubricVersion:'3.0.0', status:'incomplete', score:null, criteria:[{ id:'S2', subchecks:[{id:'S2.product-markup', status:'not_measured', points:null, earnedPoints:1, maxPoints:2, availablePoints:2, fraction:null, reason:'Waiting', evidenceIds:[], components:[{id:'S2.json-ld', status:'measured', points:1, maxPoints:1, fraction:1, reason:null, evidenceIds:[]}]}]}], evidence:[], fixes:[], coverage:{limitations:[]} }
    const html = renderToStaticMarkup(React.createElement(LiveReport, {assessment, onBack() {}}))
    assert.match(html, /Verified partial subtotal: 1 of 2 available points/)
    assert.match(html, /Product JSON-LD/)
    assert.match(html, /Final score unavailable/)
  } finally { await vite.close() }
})
