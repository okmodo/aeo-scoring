import React from 'react';
import type { Assessment } from '../contracts/v1/types';

export function LiveReport({ assessment, onBack }: { assessment: Assessment; onBack: () => void }) {
  const report = assessment.report;
  return <main className="report">
    <div className="breadcrumb"><button onClick={onBack}>← Back to start</button><span>LIVE ASSESSMENT</span></div>
    <section className="report-intro"><div><div className="eyebrow"><span className="status-dot" /> LIVE ASSESSMENT</div><h1 tabIndex={-1}> {assessment.status === 'pending' ? 'Assessment in progress' : assessment.status === 'unable_to_assess' ? 'Unable to assess' : assessment.status === 'incomplete' ? 'Assessment incomplete' : 'Your assessment'}<span className="brand-dot">.</span></h1><p>{assessment.submittedUrl}</p></div>
      <div className="report-meta"><span>REPORT DETAILS</span><strong>{report?.productName || 'Product page'}</strong><small>Created {assessment.createdAt}</small><small>Available until {assessment.expiresAt}</small>{assessment.cache.hit && <small>Reused cached assessment{assessment.cache.validUntil ? ` · reusable until ${assessment.cache.validUntil}` : ''}</small>}</div></section>
    {assessment.status === 'pending' && <div className="notice" role="status">The page is being assessed. This report updates automatically.</div>}
    {assessment.status === 'unable_to_assess' && <div className="notice" role="status">{assessment.error?.message || 'The page could not be assessed.'}</div>}
    {report && <>
      {report.status === 'incomplete' && <div className="notice"><strong>Assessment incomplete.</strong> Some checks could not be measured. No final score is available.</div>}
      <section className="summary-grid"><div className="score-card"><div className="card-kicker">{report.score ? 'OVERALL SCORE' : 'PARTIAL POINTS'}</div><div className="score">{report.score ? report.score.total : report.earnedPoints}{report.score && <small> / 100</small>}</div><p>{report.score ? 'Product content readiness' : 'Unscaled subtotal from assessed evidence'}</p>{report.score && <div className="score-splits"><div><span>STRUCTURE</span><b>{report.score.structure} <small>/ 40</small></b></div><div><span>CONTENT</span><b>{report.score.content} <small>/ 60</small></b></div></div>}</div>
      <div className="takeaway"><div className="card-kicker">COVERAGE</div><div className="takeaway-body"><h2>{report.coverage.measured} of {report.coverage.total} checks measured.</h2><p>{report.coverage.notMeasured} not measured. Rubric {report.rubricVersion}.</p>{report.coverage.limitations.map((item, i) => <p key={i}>{item}</p>)}</div></div></section>
      <section className="actions-section"><div className="section-heading"><div><div className="eyebrow">YOUR ACTION PLAN</div><h2>Make the next move<span className="brand-dot">.</span></h2><p>Potential recovery is conditional and requires reassessment.</p></div></div>
      {report.fixes.length ? <div className="action-list">{report.fixes.map((fix) => <details className="action live-detail" key={fix.id}><summary><strong>{fix.title}</strong> <span>{fix.recoverablePoints === null ? 'Recovery unknown' : `Up to +${fix.recoverablePoints} points`}</span></summary><p>{fix.condition}</p><p>Owner: {fix.owner} · Checks: {fix.checkIds.join(', ')}</p><p>Evidence: {fix.evidenceIds.join(', ') || 'None listed'}</p></details>)}</div> : <p>No fixes were provided for this assessment.</p>}
      <details className="breakdown"><summary>View checks and evidence</summary>{report.criteria.flatMap(c => c.subchecks).map(check => <div className="live-check" key={check.id}><strong>{check.id}</strong><span>{check.status === 'measured' ? `${check.points} / ${check.maxPoints}` : check.status.replace('_', ' ')}</span><p>{check.reason} {check.evidenceIds.length > 0 && `Evidence: ${check.evidenceIds.join(', ')}`}</p></div>)}</details>
      <details className="breakdown"><summary>View source evidence</summary>{report.evidence.map(e => <article className="live-evidence" key={e.id}><strong>{e.id} · {e.kind.replace('_', ' ')}</strong><p>{e.excerpt}</p><p>{e.url} · {e.method} · {e.location} · {e.observedAt}</p></article>)}</details>
      </section></>}
    <footer><span className="brand">answerable<span className="brand-dot">.</span></span><span>LIVE ASSESSMENT</span></footer>
  </main>;
}
