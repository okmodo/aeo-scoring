import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAudit } from './scoring.mjs';
import { applyRubricAssessment } from './ai-rubric-scoring.mjs';

const url = 'https://shop.example/products/item';
const component = (report, id) => report.criteria.flatMap(c => c.subchecks).flatMap(row => row.components).find(c => c.id === id);
const initial = { productHtml: { complete: true, sourceObservation: { complete: true, regions: 1, headings: [{level: 1, text: 'Item'}], blocks: [{text: 'Cotton item'}], links: [], inlineSupport: [] } }, coverage: { html: true, jsonLdTruncated: false }, jsonLd: [] };
const snapshot = { url, observedAt: '2026-11-15T00:00:00.000Z', retrievalMethod: 'browser', browser: { coverage: { initialAvailable: true, initialLimited: false, renderedLimited: false } } };

test('verified initial source findings survive absent AI and truncated source stays unknown', () => {
  const rendered = { productHtml: { complete: true, blocks: [] }, coverage: { html: true, jsonLdTruncated: false }, jsonLd: [] };
  const report = scoreAudit(snapshot, rendered, { initialExtracted: initial, requireAiAssessment: true });
  for (const id of ['S1.delivery', 'S1.readability', 'S1.scope']) assert.equal(component(report, id).fraction, 1, id);
  assert.equal(component(report, 'S1.supporting-access').status, 'not_applicable');
  const limited = scoreAudit({ ...snapshot, browser: { coverage: { initialAvailable: true, initialLimited: true } } }, rendered, { initialExtracted: initial, requireAiAssessment: true });
  for (const id of ['S1.delivery', 'S1.readability', 'S1.scope', 'S1.supporting-access', 'S2.syntax']) assert.equal(component(limited, id).status, 'not_measured', id);
});

test('locally owned structure is not replaced by unasked or unsupported AI findings', () => {
  const checks = { 'S1.scope': { status: 'measured', fraction: 0.5, evidenceIds: ['local'] }, 'S2.entity': { status: 'not_measured' }, 'S7.links': { status: 'measured', fraction: 0, evidenceIds: ['local'] }, 'C1.identity': { status: 'not_measured' } };
  const evidence = [{ url, location: 'product', excerpt: 'Item' }];
  applyRubricAssessment(checks, { findings: { 'S1.scope': { status: 'not_measured', reason: 'Unasked' }, 'S2.entity': { status: 'measured', fraction: 1, evidence }, 'S7.links': { status: 'not_measured', reason: 'Unasked' }, 'C1.identity': { status: 'measured', fraction: 1, evidence } } }, { snapshot: {}, extracted: { productHtml: { complete: true } }, addEvidence: () => 'ai', locallyOwned: new Set(['S1.scope', 'S2.entity', 'S7.links']) });
  assert.equal(checks['S1.scope'].fraction, 0.5);
  assert.equal(checks['S2.entity'].status, 'not_measured');
  assert.equal(checks['S7.links'].fraction, 0);
  assert.equal(checks['C1.identity'].fraction, 1);
});

test('support outcomes are consumed without rendered product HTML and unknowns remain unknown', () => {
  const report = scoreAudit({ ...snapshot, sitemap: { state: 'absent', url: 'https://shop.example/sitemap.xml' }, guides: { llmsState: 'absent' } }, {}, { requireAiAssessment: true });
  for (const id of ['S6.usable', 'S7.identity', 'S7.links']) assert.equal(component(report, id).fraction, 0, id);
  assert.equal(component(report, 'S6.inclusion').status, 'not_measured');
  assert.equal(component(report, 'S5.search').status, 'not_measured');
});
