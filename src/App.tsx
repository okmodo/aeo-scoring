import React, { useEffect, useRef, useState } from "react";
import { total } from "./sample";
import "./style.css";
import { getAudit, pollDelay, PreviewPasswordRequired, requestAudit } from "./audit";
import { PreviewPassword } from "./PreviewPassword";
import { LiveReport } from "./live-report/LiveReport";
import type { Assessment } from "../contracts/v1/types";
export function App() {
  const [screen, setScreen] = useState<"entry" | "live">(
      "entry",
    ),
    [url, setUrl] = useState("");
  const [password, setPassword] = useState<string | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { document.title = "Answerable — product page assessment"; return () => controller.current?.abort(); }, []);
  const entryHeading = useRef<HTMLHeadingElement>(null);
  const hasNavigated = useRef(false);
  useEffect(() => {
    if (screen === "entry" && hasNavigated.current)
      entryHeading.current?.focus();
    if (screen !== "entry") hasNavigated.current = true;
  }, [screen]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setError("");
    setSubmitting(true);
    try {
      let next = await requestAudit(url, password, request.signal);
      if (request.signal.aborted) return;
      setAssessment(next);
      setScreen("live");
      let attempt = 0;
      const deadline = Date.now() + 120_000;
      while (next.status === "pending") {
        if (Date.now() >= deadline) throw new Error("The assessment is taking longer than expected. Please try again later.");
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
          const timer = setTimeout(() => { request.signal.removeEventListener("abort", onAbort); resolve(); }, pollDelay(attempt++));
          request.signal.addEventListener("abort", onAbort, { once: true });
        });
        next = await getAudit(next.statusUrl, password, request.signal);
        if (request.signal.aborted) return;
        setAssessment(next);
      }
    } catch (err) {
      if (!request.signal.aborted) {
        if (err instanceof PreviewPasswordRequired) setPassword(null);
        setError(err instanceof TypeError ? "Could not reach the audit service. Check your connection and try again." : err instanceof Error ? err.message : "The audit service is unavailable.");
        setScreen("entry");
      }
    } finally { if (!request.signal.aborted) setSubmitting(false); }
  }
  function back() { controller.current?.abort(); setSubmitting(false); setScreen("entry"); }
  return (
    <>
      {password === null && <PreviewPassword onUnlock={setPassword} />}
      {screen !== "live" && <>
      <div className="sample-banner">
        LIVE PRODUCT PAGE ASSESSMENT <span> · </span> A fictional sample is also available below.
      </div>
      <header className="top">
        <a className="brand" href="#home" onClick={back}>
          <span className="brandmark">a</span> answerable
          <span className="brand-dot">.</span>
        </a>
        <span className="top-label">AEO REPORT</span>
        <span className="top-right">
          Built for better answers <span>↗</span>
        </span>
      </header>
      </>}
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
                  <p className="form-note">The URL is sent to our audit service and the page is fetched. Submit only public product page URLs. The shared password is required to view the report.</p>
                  <button type="submit" disabled={submitting || password === null}>{submitting ? "Starting assessment…" : "Assess product page"} <span>↗</span>
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
                <button className="blue-button" onClick={() => window.location.assign("/report-design/")}>Explore sample report ↗</button>
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
                  <p>It is sent to the audit service and used to fetch the page. Reports are unlisted and require testing access.</p>
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
                <button onClick={() => window.location.assign("/report-design/")}>Explore sample report ↗</button>
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
    </>
  );
}
