import React, { useState } from "react";
import { scenarios, type Scenario } from "./scenarios";
import { actions } from "../sample";
import { AttributeChart, OpportunityChart } from "./Charts";
import "./report.css";

const actionTitles = ["Publish missing product details", "Explain shipping", "Clarify limitations", "Consider an llms.txt file", "Consider an agent guide"];
const actionWhy = [
  "Clear specifications help shoppers compare the product and give AI systems accessible details to work with.",
  "Shipping costs and timing help shoppers understand the purchase and give AI systems useful information to relay.",
  "Verified limitations make product claims more useful and help shoppers understand where the product may not meet their needs.",
  "A maintained file can identify useful site resources for systems that choose to use it.",
  "A maintained guide can offer site context and guidance to automated agents.",
];

export function ReportDesign({ initialScenario = "complete" }: { initialScenario?: Scenario }) {
  const [selected, setSelected] = useState<Scenario>(initialScenario);
  const [actionIndex, setActionIndex] = useState(0);
  const report = scenarios[selected];
  const action = actions[actionIndex];
  return <div className="rd" id="top">
    <div className="rd-banner">TEST DATA <span>·</span> Fictional product and results for design review only</div>
    <header className="rd-header">
      <a href="/" className="rd-brand">
        <span>a</span> answerable<i>.</i>
      </a>
      <span className="rd-header-label">PRODUCT PAGE ASSESSMENT</span>
      <a href="/">Back to preview ↗</a>
    </header>
    <main className="rd-wrap">
      <div className="rd-toolbar">
        <span>REPORT PREVIEW / <strong>TEST DATA</strong>
        </span>
        <label htmlFor="rd-state">View fictional state <select id="rd-state" value={selected} onChange={event => setSelected(event.target.value as Scenario)}>{Object.entries(scenarios).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select>
        </label>
      </div>
      <section className="rd-intro">
        <div>
          <p className="rd-kicker">FICTIONAL PRODUCT ASSESSMENT</p>
          <h1>Northstar <em>Road Runner.</em>
          </h1>
          <p>US 9 · Blue · US / USD &nbsp; / &nbsp; example.com/products/northstar-road-runner</p>
        </div>
        <div className="rd-meta">
          <span>RUBRIC v1.0.0 · NOV 5, 2026, 10:00 AM UTC</span>
          <div className="rd-status" role="status" aria-live="polite">
            <b /> {report.status}</div>
        </div>
      </section>
      {selected === "complete" ? <>
        <section className="rd-hero" aria-labelledby="rd-change-title">
          <div className="rd-hero-copy">
            <p className="rd-kicker">YOUR NEXT BEST MOVES <span>✳</span>
            </p>
            <h2 id="rd-change-title">Publish the product facts <em>shoppers and AI need.</em>
            </h2>
            <p>In this fictional example, width, upper material and outsole material are missing. Verify and publish these details so shoppers and AI have more information to work with.</p>
            <a href="#rd-actions">Explore the actions ↓</a>
          </div>
          <AttributeChart />
        </section>
          <div className="rd-priorities">
            <span className="rd-kicker">START HERE</span>{actionTitles.slice(0, 3).map((title, index) => <a href="#rd-actions" key={title} onClick={() => setActionIndex(index)}>
              <span>0{index + 1}</span>
              <strong>{title}</strong>
              <b>↗</b>
            </a>)}</div>
        <section className="rd-section" id="rd-actions">
          <div className="rd-section-heading">
            <div>
              <p className="rd-kicker">01 / WHAT TO CHANGE</p>
              <h2>Turn findings into action.</h2>
            </div>
            <p>Start with the information that is missing, then verify and publish the details that apply.</p>
          </div>
          <div className="rd-workspace">
            <OpportunityChart selected={actionIndex} onSelect={setActionIndex} />
            <article className="rd-action-panel" aria-live="polite">
              <span className="rd-kicker">ACTION 0{actionIndex + 1} / {actions.length.toString().padStart(2, "0")}</span>
              <h3>{actionTitles[actionIndex]}</h3>
              <p className="rd-why">{actionWhy[actionIndex]}</p>
              <p>{action.change}</p>
              <div className="rd-owners">
                <div>
                  <small>OWNER</small>
                  <strong>{action.owner}</strong>
                </div>
                <div>
                  <small>SUPPORT</small>
                  <strong>{action.support}</strong>
                </div>
                <div>
                  <small>OPPORTUNITY</small>
                  <strong>Up to +{action.points} points</strong>
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
                  <strong>Related checks:</strong> {action.ids.map(id => { const check = report.checks.find(item => item.id === id); return check ? `${check.full} (${id})` : id; }).join("; ")}</p>
              </details>
            </article>
          </div>
        </section>
        <section className="rd-section">
          <details className="rd-measure">
            <summary>
              <span>
                <span className="rd-kicker">02 / MEASUREMENT</span>
                <strong>How improvements are measured</strong>
              </span>
              <span>View score &amp; rubric ↓</span>
            </summary>
            <div className="rd-score-grid">
              <div>
                <span>OVERALL</span>
                <strong>{report.score}<small> / 100</small>
                </strong>
              </div>
              <div>
                <span>STRUCTURE</span>
                <strong>{report.structure}<small> / 40</small>
                </strong>
              </div>
              <div>
                <span>CONTENT</span>
                <strong>{report.content}<small> / 60</small>
                </strong>
              </div>
            </div>
            <p>These are current fictional scores. Recoverable points depend on meeting each stated condition and are not guaranteed.</p>
            <Rubric checks={report.checks} complete />
          </details>
        </section>
      </> : <section className="rd-section rd-state">
        <p className="rd-kicker">ASSESSMENT STATUS</p>
        <h2>{report.status}</h2>
        <p>{report.description}</p>
        <p>No recommendations are available without sufficient evidence. Score unavailable.</p>{report.checks.length > 0 && <Rubric checks={report.checks} complete={false} />}</section>}
      <section className="rd-section rd-scope">
        <p className="rd-kicker">COVERAGE / LIMITATIONS</p>
        <h2>About this example.</h2>
        <p>This is a frozen fictional scenario, not a live inspection. The complete example models a product page, its initial and rendered content, shipping information, llms.txt and a website agent guide. No external resources were retrieved for this preview.</p>
        <p>Detailed evidence is provided for the listed opportunities. Other checks use sample scores without detailed observations. In incomplete states, checks not shown are unmeasured and should not be interpreted as failures. This example covers one selected variant, not other variants, checkout or the wider catalog. It does not verify product truth or measure actual AI citations.</p>
      </section>
    </main>
    <footer className="rd-footer">
      <span>answerable<i>.</i>
      </span>
      <p>Fictional test data · No website was assessed.</p>
      <a href="#top">Back to top ↑</a>
    </footer>
  </div>;
}

function Rubric({ checks, complete }: { checks: Readonly<typeof scenarios.complete.checks>; complete: boolean }) {
  return <details className="rd-rubric">
    <summary>View {complete ? "full rubric" : "completed checks"} <span>{checks.length} checks</span>
    </summary>{checks.map(check => <div className="rd-check" key={check.id}>
      <div>
        <strong>{check.full}</strong>
        <small>{check.id} · {check.pillar}</small>
        <details>
          <summary>View fictional observation and rubric</summary>
          <p>{actions.find(item => item.ids.includes(check.id))?.evidence ?? "The frozen example assigns full points to this check; no detailed observation was recorded for this design sample."}</p>
          <p>Full: {check.full}. Partial: {check.partial}. Zero: {check.zero}.</p>
        </details>
      </div>
      <b>{check.awarded} <small>/ {check.maxPoints}</small>
      </b>
    </div>)}</details>;
}
