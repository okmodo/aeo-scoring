import React, { useState } from "react";
import { scenarios, type Scenario } from "./scenarios";
import { actions } from "../sample";
import "./report.css";

export function ReportDesign({ initialScenario = "complete" }: { initialScenario?: Scenario }) {
  const [selected, setSelected] = useState<Scenario>(initialScenario);
  const report = scenarios[selected];
  return <div className="rd">
    <div className="rd-banner">TEST DATA <span>·</span> Fictional product and results for design review only</div>
    <header className="rd-header">
      <a href="/" className="rd-brand">
        <span>a</span> answerable<i>.</i>
      </a>
      <span className="rd-header-label">REPORT DESIGN REVIEW</span>
      <a href="/">Back to preview ↗</a>
    </header>
    <main className="rd-wrap">
      <div className="rd-toolbar">
        <span>REPORT PREVIEW / <strong>TEST DATA</strong>
        </span>
        <label htmlFor="rd-state">View fictional state <select id="rd-state" value={selected} onChange={(event) => setSelected(event.target.value as Scenario)}>{Object.entries(scenarios).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select>
        </label>
      </div>
      <section className="rd-intro">
        <div>
          <p className="rd-eyebrow">PRODUCT PAGE ASSESSMENT <span>✳</span>
          </p>
          <h1>Northstar <em>Road Runner.</em></h1>
          <p className="rd-lede">A fictional product page assessment for design review.</p>
        </div>
        <div className="rd-meta">
          <span>FICTIONAL PRODUCT</span>
          <p>US 9 · Blue · US / USD</p>
          <p>example.com/products/northstar-road-runner</p>
          <p>Rubric v1.0.0</p>
          <div className="rd-meta-line">
            <span>AUDIT TIME</span>
            <strong>Nov 5, 2026 · 10:00 AM UTC (fictional)</strong>
          </div>
          <div className="rd-status" role="status" aria-live="polite">
            <b /> {report.status}</div>
        </div>
      </section>
      <section className="rd-overview" aria-labelledby="rd-overview-title">
        <div className="rd-section-top">
          <div>
            <p className="rd-eyebrow">01 / THE OVERVIEW</p>
            <h2 id="rd-overview-title">Your score at a glance.</h2>
          </div>
          <p>One view of product information and how it is delivered.</p>
        </div>
        {report.score !== null ? <div className="rd-score-grid">
          <div className="rd-score">
            <span>OVERALL SCORE</span>
            <div>
              <strong>{report.score}</strong>
              <small> / 100</small>
            </div>
            <p>Points earned across the full rubric</p>
          </div>
          <div className="rd-breakdown">
            <div>
              <span>01</span>
              <div>
                <strong>Structure</strong>
                <p>How information is delivered</p>
              </div>
              <b>{report.structure} <small>/ 40</small>
              </b>
            </div>
            <div>
              <span>02</span>
              <div>
                <strong>Content</strong>
                <p>What the page communicates</p>
              </div>
              <b>{report.content} <small>/ 60</small>
              </b>
            </div>
          </div>
          <div className="rd-takeaway">
            <span>✳ &nbsp; KEY TAKEAWAY</span>
            <h3>Start with the missing details.</h3>
            <p>In this example, three of six essential attributes are complete. Shipping information and product limitations are also missing.</p>
            <a href="#rd-actions">See recommended actions ↓</a>
          </div>
        </div> : <div className="rd-empty">
          <strong>{report.status}</strong>
          <p>{report.description}</p>
          <span>Score unavailable</span>
        </div>}
      </section>
      {report.actions.length > 0 && <section id="rd-actions" className="rd-actions">
        <div className="rd-section-top">
          <div>
            <p className="rd-eyebrow">02 / THE OPPORTUNITIES</p>
            <h2>What to do next.</h2>
          </div>
          <p>Prioritized improvements, with the evidence and conditions behind each opportunity.</p>
        </div>
        <div className="rd-action-list">{report.actions.map((action, index) => <article className="rd-action" key={action.title}>
          <div className="rd-number">{String(index + 1).padStart(2, "0")}</div>
          <div className="rd-action-main">
            <div className="rd-action-title">
              <h3>{action.title}</h3>
              <span>UP TO +{action.points} POINTS</span>
            </div>
            <p>{action.change}</p>
            <div className="rd-action-meta">
              <div>
                <small>OWNER</small>
                <strong>{action.owner}</strong>
              </div>
              <div>
                <small>SUPPORT</small>
                <strong>{action.support}</strong>
              </div>
            </div>
            <details>
              <summary>Evidence &amp; recovery condition</summary>
              <p>
                <strong>Evidence:</strong> {action.evidence}</p>
              <p>
                <strong>Recovery:</strong> {action.condition}</p>
              <p>
                <strong>Dependency:</strong> {action.dependency}</p>
              <p>
                <strong>Related checks:</strong> {action.ids.map(id => {
                  const check = report.checks.find(c => c.id === id);
                  return check ? `${check.full} (${id})` : id;
                }).join("; ")}</p>
            </details>
          </div>
        </article>)}</div>
      </section>}
      <section className="rd-rubric">
        <div className="rd-section-top">
          <div>
            <p className="rd-eyebrow">{report.actions.length ? "03" : "02"} / THE DETAILS</p>
            <h2>Explore the checks.</h2>
          </div>
          <p>Review the fictional checks and the rubric behind them.</p>
        </div>{report.checks.length ? <details className="rd-rubric-details">
          <summary>View {selected === "complete" ? "full rubric" : "completed checks"} <span>{report.checks.length} checks</span>
          </summary>
          <div>{report.checks.map(check => <div className="rd-check" key={check.id}>
            <div>
              <strong>{check.full}</strong>
              <small>{check.id} · {check.pillar}</small>
              <details>
                <summary>View fictional observation and rubric</summary>
                <p>{actions.find(action => action.ids.includes(check.id))?.evidence ?? "The frozen example assigns full points to this check; no detailed observation was recorded for this design sample."}</p>
                <p>Full: {check.full}. Partial: {check.partial}. Zero: {check.zero}.</p>
              </details>
            </div>
            <b>{check.awarded} <small>/ {check.maxPoints}</small>
            </b>
          </div>)}</div>
        </details> : <div className="rd-empty">
          <strong>No checks to display</strong>
          <p>{report.description}</p>
        </div>}</section>
      <section className="rd-rubric" aria-labelledby="rd-scope-title">
        <p className="rd-eyebrow">COVERAGE / LIMITATIONS</p>
        <h2 id="rd-scope-title">About this example.</h2>
        <p className="rd-lede">This is a frozen fictional scenario, not a live inspection. The complete example models a product page, its initial and rendered content, shipping information, llms.txt and a website agent guide. No external resources were retrieved for this preview.</p>
        <p className="rd-lede">Scores and observations illustrate the rubric; detailed evidence is provided for the listed opportunities. Other checks use sample scores without detailed observations. In incomplete states, checks not shown are unmeasured and should not be interpreted as failures. This example covers one selected variant, not other variants, checkout or the wider catalog. It does not verify product truth or measure actual AI citations.</p>
      </section>
    </main>
    <footer className="rd-footer">
      <span>answerable<i>.</i>
      </span>
      <p>Fictional test data · No website was assessed.</p>
      <a href="#top" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>Back to top ↑</a>
    </footer>
  </div>;
}
