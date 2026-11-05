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
test("preview labels sample and does not implement merchant fetching", () => {
  const s = readFileSync("src/App.tsx", "utf8");
  assert.match(s, /No website is\s+fetched or assessed/);
  assert.match(s, /No URL was assessed/);
  assert.doesNotMatch(s, /\bfetch\s*\(/);
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
    assert.match(html, /No website is fetched or assessed/);
    assert.match(html, /Explore sample report/);
    assert.match(html, /Your URL stays in this browser/);
  } finally {
    await vite.close();
  }
});
