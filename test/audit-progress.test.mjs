import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/audit-progress.json', import.meta.url)));

test('audit loading displays the requested workflow without inventing stage completion or results', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { AuditProgress } = await vite.ssrLoadModule('/src/AuditProgress.tsx');
    for (const scenario of fixture.cases) {
      const html = renderToStaticMarkup(React.createElement(AuditProgress, { accepted: scenario.accepted, onCancel() {} }));
      assert.ok(html.includes(scenario.heading), scenario.name);
      let previous = -1;
      for (const stage of fixture.stages) { const at = html.indexOf(`<h2>${stage}</h2>`); assert.ok(at > previous, stage); previous = at; }
      assert.match(html, /role="status"/);
      assert.match(html, /role="progressbar" aria-label="Audit processing"/);
      assert.doesNotMatch(html, /aria-valuenow|stage-completed|Your test results|Points earned|Total score/);
      assert.match(html, /Your report may include partial findings/);
      assert.match(html, /Cancel waiting/);
      assert.match(html, /may continue after you leave/);
    }
  } finally { await vite.close(); }
});

test('terminal states distinguish a ready report, partial findings and a failed audit', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { AuditCompletion } = await vite.ssrLoadModule('/src/AuditProgress.tsx');
    for (const scenario of fixture.terminal) {
      const assessment = JSON.parse(readFileSync(new URL('./fixtures/report-fixtures/v2-complete.json', import.meta.url)));
      assessment.status = scenario.status;
      if (!scenario.report) assessment.report = null;
      else if (scenario.status === 'incomplete') { assessment.report.status = 'incomplete'; assessment.report.score = null; }
      const html = renderToStaticMarkup(React.createElement(AuditCompletion, { assessment }));
      if (scenario.heading === null) { assert.equal(html, ''); continue; }
      assert.ok(html.includes(scenario.heading));
      assert.ok(html.includes(scenario.message));
      assert.match(html, /role="status"/);
      assert.doesNotMatch(html, /All tests passed|100%/);
    }
    const invalid = JSON.parse(readFileSync(new URL('./fixtures/report-fixtures/v2-complete.json', import.meta.url)));
    invalid.report.rubricVersion = '99.0.0';
    const blocked = renderToStaticMarkup(React.createElement(AuditCompletion, { assessment: invalid }));
    assert.match(blocked, /could not be completed/);
    assert.doesNotMatch(blocked, /Your report is ready/);
  } finally { await vite.close(); }
});
