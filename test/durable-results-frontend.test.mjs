import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildLiveReportModel } from '../src/live-report/model.ts'

test('v3 retains row coverage, component evidence and verified subtotal', () => {
  const assessment = JSON.parse(readFileSync(new URL('./fixtures/customer-copy/assessment.json', import.meta.url)))
  const model = buildLiveReportModel(assessment)
  const check = model.checks.find(item => item.id === 'S1.readable-html')
  assert.equal(check.status, 'not_measured')
  assert.equal(check.earnedPoints, 4)
  assert.ok(check.components.some(component => component.status === 'measured'))
  assert.ok(check.components.some(component => component.status === 'not_measured'))
  assert.equal(model.report.status, 'incomplete')

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
    const partial = JSON.parse(readFileSync(new URL('./fixtures/customer-copy/assessment.json', import.meta.url)))
    const html = renderToStaticMarkup(React.createElement(LiveReport, {assessment: partial, onBack() {}}))
    assert.match(html, /Some tests could not be completed/)
    assert.match(html, /Verified \+4 points so far/)
    assert.doesNotMatch(html, /Report unavailable/)

  } finally { await vite.close() }
})
