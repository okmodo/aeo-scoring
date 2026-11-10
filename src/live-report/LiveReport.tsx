import React, { useEffect, useRef, useState } from "react";
import type { Assessment, Evidence } from "../../contracts/v1/types";
import { buildLiveReportModel, type CheckDetail, type FixDetail } from "./model";
import "../report-design/report.css";
import "./live.css";

const statusText: Record<Assessment["status"], string> = {
  pending: "Assessment in progress",
  complete: "Assessment complete",
  incomplete: "Assessment incomplete",
  unable_to_assess: "Unable to assess",
};

function date(value: string | null) {
  if (!value) return "Not available";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Sources({ evidence, missing }: { evidence: Evidence[]; missing: string[] }) {
  if (!evidence.length && !missing.length) return <p>No source details were returned.</p>;
  return <div className="rd-live-sources">{evidence.map(source => <div key={source.id}>
    <strong>{source.kind === "source_excerpt" ? "Source excerpt" : "Derived observation"} <small>({source.id})</small></strong>
    <p>{source.excerpt || "No excerpt provided."}</p>
    <small>{source.method} · {source.location || "Location unavailable"} · {date(source.observedAt)}<br />Source: {source.url || "URL unavailable"}</small>
  </div>)}{missing.length > 0 && <p>Source details unavailable for: {missing.join(", ")}.</p>}</div>;
}

function Finding({ check, fix }: { check: CheckDetail; fix?: FixDetail }) {
  const finding = (check.status === "not_measured" || (check.status === "measured" && check.fraction == null)) ? "Not measured" : check.status === "not_applicable" ? "Excluded" : check.fraction === 1 ? "Fulfilled" : check.fraction === 0 ? "Zero points" : "Partial";
  return <article className="rd-field">
    <div className="rd-field-heading"><h4>{check.label}</h4><span>{finding}</span></div>
    <p><strong>Current finding:</strong> {check.reason || check.exclusion || (check.status === "measured" && check.fraction != null ? `${check.points ?? "Unknown"} of ${check.availablePoints ?? check.maxPoints} points awarded.` : "No finding was returned.")}</p>
    <div className="rd-field-template"><small>ASSESSMENT RULE</small><p>{check.fullCredit || "The assessment did not provide a specific rule for this check."}</p>{fix?.condition && <p>Overall action condition: {fix.condition}</p>}</div>
    <dl>
      <div><dt>Where</dt><dd>Review the source location below; a specific edit location was not returned.</dd></div>
      <div><dt>Owner</dt><dd>{fix?.owner || "Not specified for this check."}</dd></div>
      <div><dt>Verify</dt><dd>{check.status === "measured" && check.fraction != null ? "Confirm the fact with its owner, publish only verified information, then reassess the page." : "Review the assessment coverage and source details before deciding whether action is needed."}</dd></div>
    </dl>
    <details className="rd-field-source"><summary>Evidence and check details</summary><p>{check.id} · {check.status.replaceAll("_", " ")}</p><Sources evidence={check.evidence} missing={check.missingEvidenceIds} /></details>
  </article>;
}

function ActionPanel({ fix, index, total }: { fix: FixDetail; index: number; total: number }) {
  return <article className="rd-action-panel" aria-live="polite">
    <span className="rd-kicker">ACTION {String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>
    <h3>{fix.title}</h3>
    <p className="rd-why">{fix.condition || "Review the evidence and confirm the change needed."}</p>
    <div className="rd-owners"><div><small>OWNER</small><strong>{fix.owner || "Not specified"}</strong></div><div><small>CONDITIONAL OPPORTUNITY</small><strong>{fix.recoverablePoints == null ? "Not specified" : `Up to +${fix.recoverablePoints} points`}</strong></div></div>
    <details><summary>Evidence &amp; related checks</summary><p>Potential points depend on the stated condition and are not guaranteed.</p><p><strong>Related checks:</strong> {fix.checks.length ? fix.checks.map(check => `${check.label} (${check.id})`).join("; ") : "None provided."}</p><Sources evidence={fix.evidence} missing={fix.missingEvidenceIds} /></details>
  </article>;
}

export function LiveReport({ assessment, onBack }: { assessment: Assessment; onBack: () => void }) {
  const model = buildLiveReportModel(assessment);
  const { report, fixes, checks, counts, finalScore } = model;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const selectedIndex = Math.max(0, fixes.findIndex(fix => fix.id === selectedId));
  const selected = fixes[selectedIndex];
  const largest = Math.max(0, ...fixes.map(fix => fix.recoverablePoints ?? 0));
  const categories = [
    ["Fulfilled", counts.measured, "fulfilled"], ["Partial", counts.partial, "partial"], ["Zero points", counts.zero, "zero"], ["Unmeasured", counts.unmeasured, "unmeasured"], ["Excluded", counts.excluded, "excluded"],
  ] as const;
  const totalChecks = categories.reduce((sum, [, value]) => sum + value, 0);
  const blockedReport = !report && assessment.report !== null;
  const displayStatus = blockedReport ? "Report unavailable" : statusText[assessment.status];
  const context = [report?.variant, report?.market, report?.currency].filter(Boolean).join(" · ");
  return <div className="rd rd-live" id="top">
    <div className="rd-banner">LIVE PRODUCT PAGE ASSESSMENT</div>
    <header className="rd-header"><a href="/" className="rd-brand" onClick={event => { event.preventDefault(); onBack(); }}><span>a</span> answerable<i>.</i></a><span className="rd-header-label">PRODUCT PAGE ASSESSMENT</span><button className="rd-live-back" onClick={onBack}>← New assessment</button></header>
    <main className="rd-wrap">
      <div className="rd-toolbar"><span>PRODUCT PAGE / <strong>LIVE REPORT</strong></span></div>
      <section className="rd-intro"><div><p className="rd-kicker">PRODUCT PAGE ASSESSMENT</p><h1 tabIndex={-1} ref={heading}>{report?.productName || "Product assessment"}</h1><p>{context || "Variant, market and currency not provided"}</p><p>Submitted: {assessment.submittedUrl}</p>{assessment.assessedUrl && assessment.assessedUrl !== assessment.submittedUrl && <p>Assessed: {assessment.assessedUrl}</p>}</div><div className="rd-meta"><span>RUBRIC {report?.rubricVersion || "UNAVAILABLE"} · COMPLETED {date(assessment.completedAt)}</span><div className="rd-status" role="status" aria-live="polite"><b /> {displayStatus}</div></div></section>
      {report ? <>
        <section className="rd-hero" aria-labelledby="rd-live-next"><div className="rd-hero-copy"><p className="rd-kicker">YOUR NEXT BEST MOVES <span>✳</span></p><h2 id="rd-live-next">{fixes.length ? <>Start with <em>what you can improve.</em></> : <>Review what <em>was measured.</em></>}</h2><p>{fixes.length ? "These actions come from the assessment’s returned findings. Review the evidence and recovery condition before making a change." : counts.unmeasured === totalChecks ? "No checks were measured, so this assessment has no findings to act on yet." : "No priority fixes were returned. Explore the check details and coverage below."}</p>{fixes.length > 0 && <a href="#live-actions">Explore the actions ↓</a>}<a className="rd-field-jump" href="#live-checks">Review check details ↓</a></div>
          <figure className="rd-chart rd-live-chart"><figcaption><p className="rd-kicker">ASSESSMENT COVERAGE</p><h3>What the checks found</h3><p>Each check is counted once. Unmeasured and excluded checks are not failures.</p></figcaption><div className="rd-live-stack" aria-label={categories.map(([label, count]) => `${label}: ${count}`).join(", ")}>{categories.map(([label, count, key]) => <span key={key} className={`rd-live-${key}`} style={{ flexGrow: count }} title={`${label}: ${count}`} />)}</div><div className="rd-live-legend">{categories.map(([label, count, key]) => <div key={key}><span><i className={`rd-live-${key}`} />{label}</span><strong>{count}</strong></div>)}</div></figure>
        </section>
        {fixes.length > 0 && <section className="rd-section" id="live-actions"><div className="rd-section-heading"><div><p className="rd-kicker">01 / WHAT TO CHANGE</p><h2>Turn findings into action.</h2></div><p>Potential points are conditional on the recovery described for each action; they should not be added together.</p></div><div className="rd-workspace"><div className="rd-opportunities"><div className="rd-chart-heading"><h3>Returned actions</h3><span>CONDITIONAL<br />POINTS</span></div><p>Select an action to see its condition and evidence.</p><div className="rd-bars">{fixes.map((fix, index) => <button key={fix.id} type="button" className={`rd-bar ${index === selectedIndex ? "is-selected" : ""}`} aria-pressed={index === selectedIndex} onClick={() => setSelectedId(fix.id)}><span>{fix.title}</span><span className="rd-bar-track"><span style={{ width: `${largest && fix.recoverablePoints != null ? fix.recoverablePoints / largest * 100 : 0}%` }} /></span><strong>{fix.recoverablePoints == null ? "—" : `+${fix.recoverablePoints}`}</strong></button>)}</div></div><ActionPanel fix={selected} index={selectedIndex} total={fixes.length} /></div></section>}
        {finalScore && <section className="rd-section"><details className="rd-measure"><summary><span><span className="rd-kicker">MEASUREMENT</span><strong>View score &amp; rubric</strong></span><span>Expand ↓</span></summary><div className="rd-score-grid"><div><span>OVERALL</span><strong>{finalScore.total}<small> / 100</small></strong></div><div><span>STRUCTURE</span><strong>{finalScore.structure}<small> / 40</small></strong></div><div><span>CONTENT</span><strong>{finalScore.content}<small> / 60</small></strong></div></div><p>Scores reflect this assessment. Conditional recoverable points are not guaranteed.</p></details></section>}
        {!finalScore && <p className="rd-live-note">Final score unavailable because the assessment is incomplete or lacks sufficient measured coverage.</p>}
        <section className="rd-section" id="live-checks"><p className="rd-kicker">CHECK DETAILS</p><h2>Review the findings.</h2><p className="rd-fields-intro">The service returns check-level findings. Exact individual field values and ready-to-publish edits are unavailable where not provided. Use the evidence to verify each finding; confirm product details before publishing.</p><div className="rd-field-list">{checks.map(check => <Finding check={check} fix={fixes.find(fix => fix.checks.some(item => item.id === check.id))} key={check.id} />)}</div></section>
        <section className="rd-section rd-scope"><p className="rd-kicker">COVERAGE / LIMITATIONS</p><h2>About this assessment.</h2><p>Created {date(assessment.createdAt)} · Expires {date(assessment.expiresAt)} · {assessment.cache.hit ? `Cached result (valid until ${date(assessment.cache.validUntil)})` : "Fresh result"}.</p><p>Category: {report.category || "Not available"}. Assessed URL: {assessment.assessedUrl || "Not available"}.</p>{report.coverage.limitations.map((item, index) => <p key={index}>{item}</p>)}{model.warnings.map((item, index) => <p key={index}>{item}</p>)}</section>
      </> : <section className="rd-section rd-state"><p className="rd-kicker">ASSESSMENT STATUS</p><h2>{displayStatus}</h2>{model.warnings.map((item, index) => <p key={index}>{item}</p>)}<p>{assessment.status === "pending" ? "We’re inspecting the product page. This report will update when the assessment finishes." : assessment.error?.message || "No report was returned. Try another public product page or try again later."}</p><p>Final score and findings are unavailable.</p><button className="rd-live-retry" onClick={onBack}>Start another assessment ↗</button></section>}
    </main><footer className="rd-footer"><span>answerable<i>.</i></span><p>Live product page assessment</p><a href="#top">Back to top ↑</a></footer>
  </div>;
}
