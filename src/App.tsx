import React, { useEffect, useRef, useState } from "react";
import { actions, checks, total } from "./sample";
import "./style.css";
export function App() {
  const [screen, setScreen] = useState<"entry" | "progress" | "report">(
      "entry",
    ),
    [url, setUrl] = useState(""),
    [open, setOpen] = useState<number | null>(0),
    [showAll, setShowAll] = useState(false);
  const reportHeading = useRef<HTMLHeadingElement>(null);
  const entryHeading = useRef<HTMLHeadingElement>(null);
  const hasNavigated = useRef(false);
  useEffect(() => {
    if (screen === "report") reportHeading.current?.focus();
    if (screen === "entry" && hasNavigated.current)
      entryHeading.current?.focus();
    if (screen !== "entry") hasNavigated.current = true;
    if (screen === "progress") {
      const timer = window.setTimeout(() => setScreen("report"), 1000);
      return () => window.clearTimeout(timer);
    }
  }, [screen]);
  function preview(e: React.FormEvent) {
    e.preventDefault();
    setScreen("progress");
  }
  return (
    <>
      <div className="sample-banner">
        SAMPLE PREVIEW <span> · </span> Synthetic data only. No website is
        fetched or assessed.
      </div>
      <header className="top">
        <a className="brand" href="#home" onClick={() => setScreen("entry")}>
          <span className="brandmark">a</span> answerable
          <span className="brand-dot">.</span>
        </a>
        <span className="top-label">AEO REPORT PREVIEW</span>
        <span className="top-right">
          Built for better answers <span>↗</span>
        </span>
      </header>
      {screen === "entry" && (
        <main className="entry" id="home">
          <div className="entry-copy">
            <div className="eyebrow">
              <span className="status-dot" /> A CLEARER VIEW OF YOUR PRODUCT
              CONTENT
            </div>
            <h1 tabIndex={-1} ref={entryHeading}>
              Make your products <em>easier to answer for.</em>
            </h1>
            <p className="lead">
              See how an AEO report can turn product page signals into a clear,
              actionable plan.
            </p>
            <form onSubmit={preview}>
              <label htmlFor="url">
                PRODUCT PAGE URL <span>OPTIONAL</span>
              </label>
              <div className="input-row">
                <input
                  id="url"
                  type="url"
                  placeholder="https://example.com/products/your-product"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
                <button type="submit">
                  Explore sample report <span>↗</span>
                </button>
              </div>
              <p className="form-note">
                This is a demonstration. Your URL stays in this browser and is
                not fetched or assessed. The report always shows the same
                fictional product.
              </p>
            </form>
            <div className="entry-foot">
              <span>01 &nbsp; Understand the score</span>
              <span>02 &nbsp; Find your next move</span>
              <span>03 &nbsp; Share with your team</span>
            </div>
          </div>
          <div className="entry-art" aria-hidden="true">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-card">
              <div className="art-head">
                SAMPLE REPORT <span>✳</span>
              </div>
              <div className="art-score">
                {total("structure") + total("content")}
                <span>/ 100</span>
              </div>
              <div className="art-rule" />
              <div className="art-line">
                <span>STRUCTURE</span>
                <b>{total("structure")} / 40</b>
              </div>
              <div className="bar">
                <i style={{ width: `${(total("structure") / 40) * 100}%` }} />
              </div>
              <div className="art-line">
                <span>CONTENT</span>
                <b>{total("content")} / 60</b>
              </div>
              <div className="bar">
                <i style={{ width: `${(total("content") / 60) * 100}%` }} />
              </div>
              <div className="art-bottom">
                A little clarity goes a long way. <span>↗</span>
              </div>
            </div>
            <div className="art-caption">
              A MORE USEFUL KIND OF AUDIT <span>✳</span>
            </div>
          </div>
        </main>
      )}
      {screen === "progress" && (
        <main className="progress" aria-live="polite">
          <div className="spinner" />
          <div className="eyebrow">PREPARING YOUR PREVIEW</div>
          <h1>
            Putting the sample together<span className="brand-dot">.</span>
          </h1>
          <p>Loading a fictional report. No website is being fetched.</p>
        </main>
      )}
      {screen === "report" && (
        <main className="report">
          <div className="breadcrumb">
            <button onClick={() => setScreen("entry")}>← Back to start</button>
            <span>PREVIEW / SAMPLE REPORT</span>
          </div>
          <section className="report-intro">
            <div>
              <div className="eyebrow">
                <span className="status-dot" /> FICTIONAL PRODUCT · SAMPLE
                REPORT
              </div>
              <h1 tabIndex={-1} ref={reportHeading}>
                Clarity starts here<span className="brand-dot">.</span>
              </h1>
              <p>Here’s what an actionable AEO report can look like.</p>
            </div>
            <div className="report-meta">
              <span>EXAMPLE PRODUCT</span>
              <strong>Northstar Road Runner</strong>
              <small>Running shoe · US 9 · Blue · US / USD</small>
              <small>Illustrative assessment · Rubric v1.0.0</small>
            </div>
          </section>
          <div className="notice">
            <strong>✳ &nbsp; This is a sample.</strong> All findings and
            evidence below are invented. No URL was assessed, and this score
            does not measure citations.
          </div>
          <section className="summary-grid">
            <div className="score-card">
              <div className="card-kicker">
                OVERALL SCORE <span>↗</span>
              </div>
              <div className="score">
                {total("structure") + total("content")}
                <small> / 100</small>
              </div>
              <p>Product content readiness</p>
              <div className="score-rule" />
              <div className="score-splits">
                <div>
                  <span>STRUCTURE</span>
                  <b>
                    {total("structure")} <small>/ 40</small>
                  </b>
                </div>
                <div>
                  <span>CONTENT</span>
                  <b>
                    {total("content")} <small>/ 60</small>
                  </b>
                </div>
              </div>
            </div>
            <div className="takeaway">
              <div className="card-kicker">
                THE MAIN TAKEAWAY <span>01 / 02</span>
              </div>
              <div className="takeaway-body">
                <div className="asterisk">✳</div>
                <h2>Good information deserves to be easy to find.</h2>
                <p>
                  In this fictional example, missing product details and
                  incomplete specifications for a simple fetcher are the biggest
                  opportunities.
                </p>
              </div>
              <div className="takeaway-foot">
                START WITH THE PLAN BELOW <span>↓</span>
              </div>
            </div>
          </section>
          <section className="actions-section">
            <div className="section-heading">
              <div>
                <div className="eyebrow">02 / YOUR ACTION PLAN</div>
                <h2>
                  Make the next move<span className="brand-dot">.</span>
                </h2>
                <p>Prioritized sample actions, ready to assign to a team.</p>
              </div>
              <div className="heading-note">
                RECOVERY IS CONDITIONAL
                <br />A RE-ASSESSMENT ESTABLISHES ACTUAL CHANGE
              </div>
            </div>
            <div className="action-list">
              {(showAll ? actions : actions.slice(0, 3)).map((a, i) => (
                <article className="action" key={a.title}>
                  <button
                    className="action-toggle"
                    aria-expanded={open === i}
                    onClick={() => setOpen(open === i ? null : i)}
                  >
                    <span className="action-num">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="action-title">
                      <small>
                        {i < 3 ? "Established practice" : "Emerging practice"} ·{" "}
                        {a.owner}
                      </small>
                      <strong>{a.title}</strong>
                    </span>
                    <span className="action-points">
                      UP TO <b>+{a.points}</b>
                      <small> POINTS</small>
                    </span>
                    <span className="toggle-icon">
                      {open === i ? "−" : "+"}
                    </span>
                  </button>
                  {open === i && (
                    <div className="action-details">
                      <div>
                        <span className="detail-label">
                          WHAT THE SAMPLE SHOWS
                        </span>
                        <p>{a.evidence}</p>
                        <span className="detail-label">RECOMMENDED CHANGE</span>
                        <p>{a.change}</p>
                      </div>
                      <div>
                        <span className="detail-label">POTENTIAL RECOVERY</span>
                        <p>{a.condition}</p>
                        <span className="detail-label">
                          ASSIGNMENT &amp; DEPENDENCY
                        </span>
                        <p>
                          Primary: {a.owner}
                          <br />
                          Supporting: {a.support}
                          <br />
                          Dependency: {a.dependency}
                          <br />
                          Evidence confidence: High (illustrative)
                        </p>
                        <span className="detail-label">AFFECTED SUBCHECKS</span>
                        <p>
                          {a.ids.map((id) => {
                            const c = checks.find((item) => item.id === id)!;
                            return (
                              <React.Fragment key={id}>
                                {id}: {c.awarded} / {c.maxPoints}
                                <br />
                              </React.Fragment>
                            );
                          })}
                        </p>
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>
            <button
              className="view-all"
              onClick={() => setShowAll(!showAll)}
              aria-expanded={showAll}
            >
              {showAll ? "Show fewer actions ↑" : "View all actions ↓"}
            </button>
            <details className="breakdown">
              <summary>View sample scoring breakdown</summary>
              <p>
                Fictional coverage assumes all applicable checks, including the
                linked shipping policy, were inspected. No real source was
                inspected. C2 essential: 3 of 6 attributes complete, earning 7 /
                14. S1 specifications: three initial, four rendered-only and
                three absent attributes yield (3 + 4 × 0.5) / 10 = 0.5, earning
                1.5 / 3. The fictional water-resistance claim makes limitations
                applicable. In this example, a linked fictional laboratory
                report supports that claim, but the page does not explain its
                use limits.
              </p>
              {checks.map((c) => (
                <div key={c.id}>
                  <span>{c.id}</span>
                  <span>
                    {c.awarded} / {c.maxPoints}
                  </span>
                </div>
              ))}
            </details>
            <p className="recovery-note">
              Potential points are illustrative rubric projections, not promises
              of traffic or citations. The fictional example assumes all
              applicable checks were assessed; no real sources were inspected.
            </p>
          </section>
          <footer>
            <span className="brand">
              answerable<span className="brand-dot">.</span>
            </span>
            <span>MADE FOR MORE USEFUL ANSWERS</span>
            <span>SAMPLE PREVIEW · NO LIVE ASSESSMENT</span>
          </footer>
        </main>
      )}
    </>
  );
}
