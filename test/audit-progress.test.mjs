import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/audit-progress.json', import.meta.url)));

test('modal presents backend stage states and leaves legacy progress indeterminate', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { AuditProgress } = await vite.ssrLoadModule('/src/AuditProgress.tsx');
    for (const scenario of fixture.cases) {
      const assessment = { id: 'a', progress: { version: '1', auditId: 'a', revision: 1, events: scenario.events } };
      const html = renderToStaticMarkup(React.createElement(AuditProgress, { assessment, onCancel() {} }));
      assert.deepEqual([...html.matchAll(/class="audit-stage-status">([^<]+)/g)].map(match => match[1]), scenario.states, scenario.name);
      assert.match(html, /<h2>Audit complete<\/h2>/);
      if (scenario.name === 'queued') {
        assert.match(html, /Waiting to start/);
        assert.match(html, /Your audit is in the queue/);
      }
      assert.match(html, /<dialog[^>]*aria-labelledby="audit-progress-heading"/);
      assert.match(html, /may continue after you leave/);
      assert.doesNotMatch(html, /aria-valuenow|All tests passed/);
    }
    const legacy = renderToStaticMarkup(React.createElement(AuditProgress, { assessment: { id: 'a' }, onCancel() {} }));
    assert.doesNotMatch(legacy, /audit-stage-status/);
  } finally { await vite.close(); }
});

test('responses cannot replace a newer revision or another audit', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { acceptAuditUpdate } = await vite.ssrLoadModule('/src/audit.ts');
    const base = { id: 'a', status: 'pending', statusUrl: '/api/v1/audits/a', progress: { version: '1', auditId: 'a', revision: 2, events: [] } };
    assert.equal(acceptAuditUpdate(base, { ...base, progress: { ...base.progress, revision: 3 } }), true);
    assert.equal(acceptAuditUpdate(base, { ...base, progress: { ...base.progress, revision: 2 } }), false);
    assert.equal(acceptAuditUpdate(base, { ...base, id: 'b' }), false);
    assert.equal(acceptAuditUpdate(base, { ...base, progress: { ...base.progress, auditId: 'b', revision: 3 } }), false);
    assert.equal(acceptAuditUpdate(base, { ...base, progress: undefined }), false);
    assert.equal(acceptAuditUpdate({ ...base, progress: undefined }, { ...base, progress: undefined, status: 'complete' }), true);
    assert.equal(acceptAuditUpdate(base, { ...base, status: 'complete' }), true);
    assert.equal(acceptAuditUpdate({ ...base, status: 'complete' }, base), false);
  } finally { await vite.close(); }
});

test('completion distinguishes published partial reports from failures', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { AuditCompletion } = await vite.ssrLoadModule('/src/AuditProgress.tsx');
    const assessment = JSON.parse(readFileSync(new URL('./fixtures/report-fixtures/v2-complete.json', import.meta.url)));
    assessment.status = 'pending';
    assert.equal(renderToStaticMarkup(React.createElement(AuditCompletion, { assessment })), '');
    assessment.status = 'incomplete';
    assessment.report.status = 'incomplete';
    assessment.report.score = null;
    assert.match(renderToStaticMarkup(React.createElement(AuditCompletion, { assessment })), /partial findings/);
    assessment.status = 'unable_to_assess';
    assessment.report = null;
    assert.match(renderToStaticMarkup(React.createElement(AuditCompletion, { assessment })), /could not be completed/);
  } finally { await vite.close(); }
});


test('malformed optional progress is discarded without hiding the report', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { validatedProgress } = await vite.ssrLoadModule('/src/audit.ts');
    const { AuditProgress } = await vite.ssrLoadModule('/src/AuditProgress.tsx');
    const valid = { version: '1', auditId: 'a', revision: 1, events: [{ sequence: 1, stage: 'retrieval', status: 'running' }] };
    assert.deepEqual(validatedProgress(valid, 'a'), valid);
    for (const invalid of [
      { ...valid, events: undefined }, { ...valid, events: {} }, { ...valid, revision: NaN },
      { ...valid, auditId: 'b' }, { ...valid, events: [...valid.events, ...valid.events] },
      { ...valid, events: [{ sequence: 17, stage: 'retrieval', status: 'running' }] },
      { ...valid, events: [{ sequence: 1, stage: 'unknown', status: 'running' }] },
      { ...valid, events: Array(17).fill(valid.events[0]) },
    ]) {
      assert.equal(validatedProgress(invalid, 'a'), undefined);
      const html = renderToStaticMarkup(React.createElement(AuditProgress, { assessment: { id: 'a', progress: invalid }, onCancel() {} }));
      assert.doesNotMatch(html, /audit-stage-status/);
    }
  } finally { await vite.close(); }
});
