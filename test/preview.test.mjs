import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("sample score and action recovery reconcile with rubric without duplicate subchecks", async () => {
  const { deductions, actions, total } = await import("../src/sample.ts");
  const rubric = JSON.parse(readFileSync("config/rubric.v1.json"));

  const checks = rubric.criteria.flatMap((c) =>
    c.subchecks.map((s) => ({ ...s, pillar: c.pillar })),
  );
  for (const [id, value] of Object.entries(deductions)) {
    const c = checks.find((x) => x.id === id);
    assert.ok(c);
    assert.ok(value <= c.maxPoints);
  }
  assert.equal(
    checks
      .filter((c) => c.pillar === "structure")
      .reduce((n, c) => n + c.maxPoints - (deductions[c.id] ?? 0), 0),
    36.5,
  );
  assert.equal(
    checks
      .filter((c) => c.pillar === "content")
      .reduce((n, c) => n + c.maxPoints - (deductions[c.id] ?? 0), 0),
    48,
  );
  assert.equal(total("structure"), 36.5);
  assert.equal(total("content"), 48);
  for (const id of Object.keys(deductions))
    assert.equal(
      actions.flatMap((a) => a.ids).filter((x) => x === id).length,
      1,
      `${id} assigned once`,
    );
  for (const action of actions)
    assert.equal(
      action.points,
      action.ids.reduce((sum, id) => sum + deductions[id], 0),
    );
});


test("fictional running shoe score agrees with the reference scorer", async () => {
  const { scoreReference } = await import("../scripts/scoring-foundations.mjs");
  const { deductions, essentialAttributes, attributeDelivery } =
    await import("../src/sample.ts");
  const rubric = JSON.parse(readFileSync("config/rubric.v1.json")),
    categories = JSON.parse(readFileSync("config/categories.v1.json"));
  const fixture = JSON.parse(
    readFileSync("evals/fixtures/scoring/reference.v1.json"),
  ).cases[0].input;
  const category = categories.categories.find((c) => c.id === "running-shoes");
  assert.deepEqual(
    category.essentialAttributes.map((a) => a.id),
    ["size", "width", "surface", "upper", "outsole", "color"],
  );
  assert.deepEqual(
    category.supportingAttributes.map((a) => a.id),
    ["weight", "drop", "closure", "care"],
  );
  assert.equal(essentialAttributes.length, category.essentialAttributes.length);
  assert.equal(attributeDelivery.length, category.essentialAttributes.length + category.supportingAttributes.length);
  const delivery = attributeDelivery;
  assert.equal(delivery.reduce((a, b) => a + b, 0) / delivery.length, 0.5);
  const essential = essentialAttributes;
  const fraction = essential.reduce((a, b) => a + b, 0) / essential.length;
  assert.equal(fraction, 0.5);

  for (const [id, value] of Object.entries(deductions)) {
    const c = rubric.criteria
      .flatMap((c) => c.subchecks)
      .find((c) => c.id === id);
    fixture.checks[id] = {
      status: "measured",
      fraction: 1 - value / c.maxPoints,
      evidence: "Synthetic example",
    };
  }
  const result = scoreReference(rubric, categories, fixture);
  assert.equal(result.finalScore, 84.5);
  assert.equal(result.criteria.C2.points, 13);
});

test("preview component renders at runtime", async () => {
  const { createServer } = await import("vite");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  try {
    const { App } = await vite.ssrLoadModule("/src/App.tsx");
    const React = await import("react");
    const html = renderToStaticMarkup(React.createElement(App));
    assert.match(html, /Assess product page/);
    assert.match(html, /Explore sample report/);
    assert.match(html, /<dialog[^>]*aria-labelledby="preview-password-heading"/);
    assert.match(html, /type="password"/);
    assert.match(html, /<button type="submit" disabled="">Assess product page/);
  } finally {
    await vite.close();
  }
});

test("landing presents navigable sections and a distinct fictional sample", async () => {
  const { createServer } = await import("vite");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
  try {
    const { App } = await vite.ssrLoadModule("/src/App.tsx");
    const React = await import("react");
    const html = renderToStaticMarkup(React.createElement(App));
    for (const id of ["how", "preview", "scope", "faq"]) {
      assert.match(html, new RegExp(`href="#${id}"`));
      assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(html, /Structure accounts for 40 points and content accounts for 60 points/);
    assert.match(html, /84\.5/);
    assert.doesNotMatch(html, /type="email"|type="tel"|Preparing your preview/i);
  } finally {
    await vite.close();
  }
});

test("report design scenarios render honest fictional states and reconcile scores", async () => {
  const { createServer } = await import("vite");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
  try {
    const { ReportDesign } = await vite.ssrLoadModule("/src/report-design/ReportDesign.tsx");
    const { scenarios } = await vite.ssrLoadModule("/src/report-design/scenarios.ts");
    assert.equal(scenarios.complete.score, 84.5);
    assert.equal(scenarios.complete.structure, 36.5);
    assert.equal(scenarios.complete.content, 48);
    assert.equal(scenarios.complete.checks.length, JSON.parse(readFileSync("config/rubric.v1.json")).criteria.flatMap(c => c.subchecks).length);
    assert.equal(scenarios.complete.actions.reduce((sum, action) => sum + action.points, 0), 15.5);
    for (const key of ["complete", "incomplete", "zero", "unavailable"]) {
      const html = renderToStaticMarkup(React.createElement(ReportDesign, { initialScenario: key }));
      assert.match(html, /TEST DATA/);
      assert.match(html, /Fictional/);
      assert.match(html, new RegExp(scenarios[key].status));
      if (key !== "complete") {
        assert.equal(scenarios[key].score, null);
        assert.match(html, /Score unavailable/);
      }
    }
    const html = renderToStaticMarkup(React.createElement(ReportDesign));
    assert.match(html, /84\.5/);
    assert.match(html, /Evidence &amp; recovery condition/);
    assert.match(html, /View full rubric/);
    assert.doesNotMatch(html, /https?:\/\//);
  } finally { await vite.close(); }
});

test("report visuals use sample data and explain conditional changes", async () => {
  const { createServer } = await import("vite");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
  try {
    const { ReportDesign } = await vite.ssrLoadModule("/src/report-design/ReportDesign.tsx");
    const { essentialAttributes, actions } = await vite.ssrLoadModule("/src/sample.ts");
    const html = renderToStaticMarkup(React.createElement(ReportDesign));
    assert.match(html, new RegExp(`${essentialAttributes.reduce((a, b) => a + b, 0)} of ${essentialAttributes.length} essential attributes`));
    assert.match(html, /If verified &amp; published/);
    assert.match(html, /not an achieved result/);
    assert.match(html, /not guaranteed/);
    assert.match(html, /How improvements are measured/);
    assert.ok(html.indexOf("Make the details complete") < html.indexOf("Opportunities by action"));
    for (const action of actions) assert.match(html, new RegExp(`\\+${action.points}`.replace(".", "\\.")));
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
    for (const key of ["incomplete", "zero", "unavailable"]) {
      const state = renderToStaticMarkup(React.createElement(ReportDesign, { initialScenario: key }));
      assert.doesNotMatch(state, /Opportunities by action|Make the details complete/);
      assert.match(state, /No recommendations are available/);
    }
  } finally { await vite.close(); }
});

test("field-level changes cover the frozen action evidence and appear only with complete findings", async () => {
  const { createServer } = await import("vite");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
  try {
    const { ReportDesign } = await vite.ssrLoadModule("/src/report-design/ReportDesign.tsx");
    const { fieldGroups } = await vite.ssrLoadModule("/src/report-design/fields.ts");
    const { actions } = await vite.ssrLoadModule("/src/sample.ts");
    assert.deepEqual(fieldGroups.map(group => group.action), actions.map(action => action.title));
    const fields = fieldGroups.flatMap(group => group.fields);
    assert.equal(fields.length, 11);
    assert.deepEqual(fields.map(field => field.name), ["Width", "Upper material", "Outsole material", "Rendered-only supporting attributes (4 fields)", "Shipping cost", "Delivery timing", "Water-resistance limits", "Site identity", "Resource links", "Site context", "Agent guidance"]);
    for (const field of fields) {
      assert.match(field.edit, /\[verified /i);
      for (const key of ["finding", "publish", "owner", "verify"]) assert.ok(field[key]);
    }
    const html = renderToStaticMarkup(React.createElement(ReportDesign));
    assert.match(html, /Review field-level changes/);
    assert.match(html, /NOT PUBLISH-READY/);
    assert.ok(html.indexOf("How improvements are measured") < html.indexOf("Exactly what to update"));
    assert.ok(html.indexOf("Exactly what to update") < html.indexOf("About this example"));
    for (const state of ["incomplete", "zero", "unavailable"]) {
      const result = renderToStaticMarkup(React.createElement(ReportDesign, { initialScenario: state }));
      assert.doesNotMatch(result, /Exactly what to update|Review field-level changes/);
    }
  } finally { await vite.close(); }
});

await import('./live-report.test.mjs');

test('live transport restricts report locations and preserves server errors and cancellation', async () => {
  const { auditStatusUrl, requestAudit, getAudit, pollDelay, unlockPreview, PreviewPasswordRequired, AUDIT_ORIGIN } = await import('../src/audit.ts');
  assert.equal(auditStatusUrl('/api/v1/audits/test-id'), AUDIT_ORIGIN + '/api/v1/audits/test-id');
  for (const path of ['https://example.com/api/v1/audits/x', '//example.com/x', '/api/v1/audits/../secret', '/api/v1/audits/x?token=y']) assert.throws(() => auditStatusUrl(path));
  assert.deepEqual([0, 1, 2, 3, 10].map(pollDelay), [2000, 4000, 8000, 10000, 10000]);
  const password = 'test-preview-password';
  const original = globalThis.fetch;
  const controller = new AbortController();
  const pending = JSON.parse(readFileSync('contracts/v1/examples/submission-pending.json'));
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, AUDIT_ORIGIN + '/api/v1/preview-access');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.get('Authorization'), 'Bearer ' + password);
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, undefined);
      return new Response(null, { status: 204 });
    };
    await unlockPreview(password, controller.signal);
    globalThis.fetch = async () => new Response(null, { status: 401 });
    await assert.rejects(unlockPreview(password, controller.signal), /password didn’t match/);
    await assert.rejects(getAudit(pending.statusUrl, password, controller.signal), PreviewPasswordRequired);
    globalThis.fetch = async () => new Response(null, { status: 404 });
    await assert.rejects(unlockPreview(password, controller.signal), /Testing access is unavailable/);
    globalThis.fetch = async (url, options) => {
      assert.equal(url, AUDIT_ORIGIN + '/api/v1/audits');
      assert.equal(options.headers.get('Authorization'), 'Bearer ' + password);
      assert.equal(options.redirect, 'error');
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { url: 'https://example.com/product' });
      assert.equal(options.signal, controller.signal);
      return Response.json(pending);
    };
    assert.deepEqual(await requestAudit('https://example.com/product', password, controller.signal), pending);
    globalThis.fetch = async () => Response.json({ error: { message: 'Please wait', retryAfterSeconds: 60 } }, { status: 429 });
    await assert.rejects(getAudit(pending.statusUrl, password, controller.signal), /Please wait.*60 seconds/);
    globalThis.fetch = async () => Response.json({ version: '2', status: 'complete' });
    await assert.rejects(getAudit(pending.statusUrl, password, controller.signal), /invalid response/);
    globalThis.fetch = async () => Response.json({ ...pending, statusUrl: 'https://example.com/private' });
    await assert.rejects(getAudit(pending.statusUrl, password, controller.signal), /invalid report address/);
    controller.abort();
    globalThis.fetch = async (_url, options) => { options.signal.throwIfAborted(); };
    await assert.rejects(getAudit(pending.statusUrl, password, controller.signal), { name: 'AbortError' });
  } finally { globalThis.fetch = original; }
});
