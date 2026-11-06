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

test("live and fictional reports render contract states without inventing scores", async () => {
  const { createServer } = await import("vite");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
  try {
    const { App } = await vite.ssrLoadModule("/src/App.tsx");
    const { LiveReport } = await vite.ssrLoadModule("/src/LiveReport.tsx");
    const landing = renderToStaticMarkup(React.createElement(App));
    assert.match(landing, /Assess product page/);
    assert.match(landing, /anyone with the report link can view it/);
    assert.match(landing, /Explore sample report/);
    assert.doesNotMatch(landing, /type="email"|type="tel"/);
    const render = name => renderToStaticMarkup(React.createElement(LiveReport, { assessment: JSON.parse(readFileSync(`contracts/v1/examples/${name}.json`)), onBack() {} }));
    assert.match(render("status-pending"), /Assessment in progress/);
    assert.match(render("assessment-complete"), /OVERALL SCORE/);
    const incomplete = render("assessment-incomplete");
    assert.match(incomplete, /Assessment incomplete/);
    assert.match(incomplete, /No final score is available/);
    assert.match(incomplete, /not measured/);
    assert.doesNotMatch(incomplete, /OVERALL SCORE/);
    assert.match(render("retrieval-failure"), /Unable to assess/);
    assert.match(render("cached-assessment"), /Reused cached assessment/);
    assert.match(incomplete, /View source evidence/);
  } finally { await vite.close(); }
});

test("audit transport restricts polling and maps service errors", async () => {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
  const original = globalThis.fetch;
  try {
    const { auditStatusUrl, pollDelay, requestAudit } = await vite.ssrLoadModule("/src/audit.ts");
    assert.match(auditStatusUrl('/api/v1/audits/abc-123'), /^https:\/\/aeo-audit-public-20261105/);
    for (const bad of ['https://evil.test/api/v1/audits/x', '//evil.test', '/api/v1/audits/../x', '/api/v1/audits/x?next=evil']) assert.throws(() => auditStatusUrl(bad));
    assert.deepEqual([0,1,2,3,4].map(pollDelay), [2000,4000,8000,10000,10000]);
    for (const [fixture, status, expected] of [['invalid-input', 400, /./], ['rate-limited', 429, /seconds/], ['service-unavailable', 503, /./]]) {
      globalThis.fetch = async () => new Response(readFileSync(`contracts/v1/examples/${fixture}.json`), { status, headers: { 'Content-Type': 'application/json' } });
      await assert.rejects(requestAudit('https://example.com', new AbortController().signal), expected);
    }
    globalThis.fetch = async () => { throw new TypeError('network'); };
    await assert.rejects(requestAudit('https://example.com', new AbortController().signal), TypeError);
  } finally { globalThis.fetch = original; await vite.close(); }
});
