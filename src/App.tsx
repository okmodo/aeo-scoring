import React, { useEffect, useRef, useState } from "react";
import { actions, checks, total } from "./sample";
import "./style.css";
import { getAudit, pollDelay, requestAudit } from "./audit";
import { LiveReport } from "./LiveReport";
import type { Assessment } from "../contracts/v1/types";
export function App() {
  const [screen, setScreen] = useState<"entry" | "report" | "live">(
      "entry",
    ),
    [url, setUrl] = useState(""),
    [open, setOpen] = useState<number | null>(0),
    [showAll, setShowAll] = useState(false);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const reportHeading = useRef<HTMLHeadingElement>(null);
  const entryHeading = useRef<HTMLHeadingElement>(null);
  const hasNavigated = useRef(false);
  useEffect(() => {
    if (screen === "report") reportHeading.current?.focus();
    if (screen === "entry" && hasNavigated.current)
      entryHeading.current?.focus();
    if (screen !== "entry") hasNavigated.current = true;
  }, [screen]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setError("");
    setSubmitting(true);
    try {
      let next = await requestAudit(url, request.signal);
      if (request.signal.aborted) return;
      setAssessment(next);
      setScreen("live");
      let attempt = 0;
      while (next.status === "pending") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, pollDelay(attempt++));
          request.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
        });
        next = await getAudit(next.statusUrl, request.signal);
        if (request.signal.aborted) return;
        setAssessment(next);
      }
    } catch (err) {
      if (!request.signal.aborted) {
        setError(err instanceof TypeError ? "Could not reach the audit service. Check your connection and try again." : err instanceof Error ? err.message : "The audit service is unavailable.");
        setScreen("entry");
      }
    } finally { if (!request.signal.aborted) setSubmitting(false); }
  }
  function back() { controller.current?.abort(); setSubmitting(false); setScreen("entry"); }
  return (
    <>
      <div className="sample-banner">
        LIVE PRODUCT PAGE ASSESSMENT <span> · </span> A fictional sample is also available below.
      </div>
      <header className="top">
        <a className="brand" href="#home" onClick={() => setScreen("entry")}>
          <span className="brandmark">a</span> answerable
          <span className="brand-dot">.</span>
        </a>
        <span className="top-label">AEO REPORT</span>
        <span className="top-right">
          Built for better answers <span>↗</span>
        </span>
      </header>
      {screen === "entry" && (
        <main id="home">
          <nav className="section-nav" aria-label="Page sections">
            <strong>AEO report</strong>
            <a href="#how">How it works</a>
            <a href="#preview">Sample score</a>
            <a href="#scope">Scope</a>
            <a href="#faq">FAQ</a>
          </nav>
          <section className="hero">
            <div className="landing-wrap hero-grid">
              <div className="hero-copy">
                <div className="eyebrow">PRODUCT CONTENT READINESS</div>
                <h1 tabIndex={-1} ref={entryHeading}>Make your products easier to answer for.</h1>
                <p>See how a clear, actionable AEO report can help your team understand product page signals and decide what to improve.</p>
                <a className="hero-link" href="#how">See how it works <span>↓</span>
                </a>
                <ul className="hero-points">
                  <li>A practical score and evidence</li>
                  <li>Prioritized actions for your team</li>
                  <li>A fictional example, ready to explore</li>
                </ul>
              </div>
              <form className="audit-card" onSubmit={submit}>
                <div className="audit-bar">LIVE AUDIT <span>✳</span>
                </div>
                <div className="audit-body">
                  <h2>Assess a product page</h2>
                  <p>Enter a public product page URL to start an assessment.</p>
                  <label htmlFor="url">Product page URL
                  </label>
                  <input id="url" type="url" required placeholder="https://example.com/products/your-product" value={url} onChange={(e) => setUrl(e.target.value)} />
                  <p className="form-note">The URL is sent to our audit service and the page is fetched. Submit only public URLs suitable for an unlisted report; anyone with the report link can view it.</p>
                  <button type="submit" disabled={submitting}>{submitting ? "Starting assessment…" : "Assess product page"} <span>↗</span>
                  </button>
                  {error && <p role="alert">{error}</p>}
                </div>
              </form>
            </div>
          </section>
          <section className="landing-section beige" id="how">
            <div className="landing-wrap">
              <div className="landing-head">
                <div className="eyebrow">HOW IT WORKS</div>
                <h2>From product signals to a practical plan.</h2>
                <p>Explore the fictional example to see how a report brings the pieces together.</p>
              </div>
              <div className="steps-grid">
                <article>
                  <span>01</span>
                  <h3>Review the page</h3>
                  <p>The example illustrates product information and technical signals an assessment can consider.</p>
                </article>
                <article>
                  <span>02</span>
                  <h3>Understand the score</h3>
                  <p>Structure accounts for 40 points and content accounts for 60 points.</p>
                </article>
                <article>
                  <span>03</span>
                  <h3>Find the gaps</h3>
                  <p>Evidence and a detailed breakdown explain the fictional findings.</p>
                </article>
                <article>
                  <span>04</span>
                  <h3>Take action</h3>
                  <p>Prioritized recommendations identify possible owners and dependencies.</p>
                </article>
              </div>
            </div>
          </section>
          <section className="landing-section lavender" id="preview">
            <div className="landing-wrap">
              <div className="landing-head">
                <div className="eyebrow">WHAT YOU GET</div>
                <h2>A score, the evidence, and your next moves.</h2>
                <p>See how the fictional running shoe example is assessed.</p>
              </div>
              <div className="preview-card">
                <div className="preview-heading">
                  <h3>Northstar Road Runner</h3>
                  <span>ILLUSTRATIVE EXAMPLE</span>
                </div>
                <div className="preview-tiles">
                  <div>
                    <span>Overall score</span>
                    <strong>{total("structure")+total("content")}<small> / 100</small>
                    </strong>
                  </div>
                  <div>
                    <span>Structure</span>
                    <strong>{total("structure")}<small> / 40</small>
                    </strong>
                  </div>
                  <div>
                    <span>Content</span>
                    <strong>{total("content")}<small> / 60</small>
                    </strong>
                  </div>
                </div>
                <p>Open the sample for the full breakdown, supporting evidence, and prioritized recommendations. Scores describe readiness; they do not predict traffic or citations.</p>
                <button className="blue-button" onClick={() => setScreen("report")}>Explore sample report ↗</button>
              </div>
            </div>
          </section>
          <section className="landing-section scope-section" id="scope">
            <div className="landing-wrap">
              <div className="landing-head">
                <div className="eyebrow">THE COMPLETE PICTURE</div>
                <h2>Understand what the report covers.</h2>
                <p>The example separates page structure from product content, with recommendations your team can use.</p>
              </div>
              <div className="scope-grid">
                <article>
                  <h3>Structure · 40 points</h3>
                  <p>Signals such as access, rendering, and structured data that can affect how product information is understood.</p>
                </article>
                <article>
                  <h3>Content · 60 points</h3>
                  <p>Product details, useful answers, claims, and other information that can help people understand a product.</p>
                </article>
              </div>
            </div>
          </section>
          <section className="landing-section beige" id="faq">
            <div className="landing-wrap">
              <div className="landing-head">
                <div className="eyebrow">FAQ</div>
                <h2>Questions about the assessment</h2>
              </div>
              <div className="faq-list">
                <details>
                  <summary>Does this assess my website?</summary>
                  <p>Yes. The live audit fetches the public page you submit. The separate sample shows fictional findings.</p>
                </details>
                <details>
                  <summary>What happens to the URL I enter?</summary>
                  <p>It is sent to the audit service and used to fetch the page. Reports are unlisted; anyone with the report link can view one.</p>
                </details>
                <details>
                  <summary>What does the score measure?</summary>
                  <p>The score describes product content readiness. It does not predict traffic, recommendations, or citations.</p>
                </details>
                <details>
                  <summary>Will anything on my website change?</summary>
                  <p>No. The assessment reads the page and does not change your site.</p>
                </details>
              </div>
              <div className="final-cta">
                <h2>See what a useful AEO report looks like.</h2>
                <button onClick={() => setScreen("report")}>Explore sample report ↗</button>
              </div>
            </div>
          </section>
          <footer>
            <span className="brand">answerable<span className="brand-dot">.</span>
            </span>
            <span>LIVE ASSESSMENT · FICTIONAL SAMPLE AVAILABLE</span>
          </footer>
        </main>
      )}
      {screen === "live" && assessment && <LiveReport assessment={assessment} onBack={back} />}
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
