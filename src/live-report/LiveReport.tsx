import React, { useEffect, useRef, useState } from 'react';
import type { Assessment, Evidence } from '../../contracts/v1/types';
import { buildLiveReportModel, type CheckDetail } from './model';
import { findingsForTest, formatPoints, pointsForTest, resultForTest, summarizeTestPoints } from './test-copy';
import '../report-design/report.css';
import './live.css';

const statusText: Record<Assessment['status'], string> = {
  pending: 'Checking your product page',
  complete: 'All tests completed',
  incomplete: 'Some tests could not be completed',
  unable_to_assess: 'We couldn’t assess this page',
};

function date(value: string | null) {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? 'Not available' :
    parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function Sources({ evidence, missing }: { evidence: Evidence[]; missing: string[] }) {
  return (
    <details className="rd-live-sources">
      <summary>View website evidence</summary>
      {evidence.map(source => (
        <div key={source.id}>
          <strong>{source.kind === 'source_excerpt' ? 'Website excerpt' : 'Audit observation'}</strong>
          <p>{source.excerpt || 'No excerpt was provided.'}</p>
          <small>{source.url || 'Website address unavailable'}<br />
            {source.location || 'Page location unavailable'} · {date(source.observedAt)}
          </small>
        </div>
      ))}
      {!evidence.length && <p>The audit did not include a website excerpt for this test.</p>}
      {missing.length > 0 && <p>Some referenced website evidence is unavailable.</p>}
    </details>
  );
}

function TestPoints({ check }: { check: CheckDetail }) {
  const points = pointsForTest(check);
  if (!points) return <span className="rd-test-no-points">Points unavailable</span>;
  return (
    <span className="rd-test-points">
      <span>Earned <strong>+{formatPoints(points.earned)}</strong></span>
      <span>Missed <strong>{points.missed === 0 ? '0' : '−' + formatPoints(points.missed)}</strong></span>
    </span>
  );
}

function TestFinding({ check }: { check: CheckDetail }) {
  const copy = check.copy;
  const result = resultForTest(check);
  const points = pointsForTest(check);
  const findings = findingsForTest(check);
  return (
    <article className="rd-test-detail" aria-live="polite" aria-atomic="true">
      <span className={'rd-test-result rd-test-' + result.toLowerCase().replaceAll(' ', '-')}>{result}</span>
      <h3>{copy.name}</h3>
      <p className="rd-test-description">{copy.description}</p>
      <TestPoints check={check} />
      {points && <p className="rd-test-point-note">
        {formatPoints(points.earned)} of {formatPoints(points.available)} available points earned in this audit.
        {result === 'Fail' && points.earned > 0 && ' Some requirements were met, so this test earned partial points.'}
      </p>}
      <h4>What we found</h4>
      {findings.slice(0, 3).map((finding, index) => <div className="rd-test-finding" key={index}><small>{finding.label}</small><p>{finding.text}</p></div>)}
      {result === 'Fail' && (
        <div className="rd-test-change">
          <h4>What to change</h4>
          <p>{check.guidance || copy.improve}</p>
          <p className="rd-test-point-note">Verify the details before publishing, then run a new audit to check the result.</p>
        </div>
      )}
      {result === 'Pass' && <p>This test met all of its requirements in the information assessed.</p>}
      {result === 'Not completed' && <p>This test has no pass or fail result. More page information or further assessment is needed.</p>}
      <Sources evidence={check.evidence} missing={check.missingEvidenceIds} />
    </article>
  );
}

export function LiveReport({ assessment, onBack }: { assessment: Assessment; onBack: () => void }) {
  const model = buildLiveReportModel(assessment);
  const { report, checks } = model;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);

  const defaultCheck = checks.find(check => resultForTest(check) === 'Fail') ?? checks[0];
  const selected = checks.find(check => check.id === selectedId) ?? defaultCheck;
  const counts = { Pass: 0, Fail: 0, 'Not completed': 0, 'Not applicable': 0 };
  checks.forEach(check => { counts[resultForTest(check)]++; });
  const finalScore = counts['Not completed'] === 0 ? model.finalScore : null;
  const completed = counts.Pass + counts.Fail;
  const pointSummary = summarizeTestPoints(checks, finalScore?.total ?? null);
  const scoreLabel = finalScore ? 'Total score' : 'Points so far';
  const scoredEnd = pointSummary.earned + pointSummary.missed;
  const context = [report?.variant, report?.market, report?.currency].filter(Boolean).join(' · ');
  const displayStatus = model.warnings.length && !report ? 'Report unavailable' : statusText[assessment.status];

  return (
    <div className="rd rd-live" id="top">
      <div className="rd-banner">LIVE PRODUCT PAGE REPORT</div>
      <header className="rd-header">
        <a href="/" className="rd-brand" onClick={event => { event.preventDefault(); onBack(); }}>
          <span>a</span> answerable<i>.</i>
        </a>
        <button className="rd-live-back" onClick={onBack}>← Check another page</button>
      </header>
      <main className="rd-wrap">
        <section className="rd-intro">
          <div>
            <h1 tabIndex={-1} ref={heading}>{report?.productName || 'Your product page report'}</h1>
            {context && <p>{context}</p>}
            <p className="rd-live-page">Product page: {assessment.assessedUrl || assessment.submittedUrl}</p>
          </div>
          <div className="rd-meta">
            {assessment.completedAt && <span>Checked {date(assessment.completedAt)}</span>}
            <div className="rd-status" role="status" aria-live="polite"><b />{displayStatus}</div>
          </div>
        </section>
        {report ? (
          <>
            <section className="rd-hero" aria-labelledby="rd-live-summary">
              <div className="rd-hero-copy">
                <h2 id="rd-live-summary">See what works.<br /><em>Know what to improve.</em></h2>
                <p>{completed} of {checks.length} tests completed. {counts.Pass} passed and {counts.Fail} failed.</p>
                {counts['Not completed'] > 0 && <p>{counts['Not completed']} tests could not be completed with the information available.</p>}
                {counts['Not applicable'] > 0 && <p>{counts['Not applicable']} tests do not apply to this product.</p>}
                <a href="#live-tests">Review your test results ↓</a>
              </div>
              <figure className="rd-chart rd-live-chart">
                <figcaption><h3>Your results at a glance</h3></figcaption>
                <div className="rd-points-doughnut" role="img"
                  aria-label={scoreLabel + ': ' + formatPoints(pointSummary.earned) + ' of 100. ' +
                    formatPoints(pointSummary.missed) + ' points missed. ' +
                    formatPoints(pointSummary.unscored) + ' points not yet scored.'}
                  style={{ background: 'conic-gradient(#061135 0% ' + pointSummary.earned + '%, #c97665 ' +
                    pointSummary.earned + '% ' + scoredEnd + '%, #dfddd7 ' + scoredEnd + '% 100%)' }}>
                  <div className="rd-points-centre" aria-hidden="true">
                    <span>{scoreLabel}</span>
                    <strong>{formatPoints(pointSummary.earned)}<small> / 100</small></strong>
                  </div>
                </div>
                {!finalScore && <p className="rd-points-pending">Total score pending. Points may change as the remaining tests are completed.</p>}
                <div className="rd-live-legend rd-points-legend">
                  <div><span><i className="rd-live-fulfilled" />Points earned</span><strong>{formatPoints(pointSummary.earned)}</strong></div>
                  <div><span><i className="rd-live-zero" />Points missed</span><strong>{formatPoints(pointSummary.missed)}</strong></div>
                  <div><span><i className="rd-live-unmeasured" />Not yet scored</span><strong>{formatPoints(pointSummary.unscored)}</strong></div>
                </div>
              </figure>
            </section>

            <section className="rd-section" id="live-tests">
              <div className="rd-section-heading">
                <div><h2>Your test results</h2></div>
                <p>Select a test to see what was found on your website and what needs attention.</p>
              </div>
              {checks.length > 0 ? (
                <div className="rd-test-workspace">
                  <div className="rd-test-list" role="group" aria-label="Website tests">
                    <div className="rd-test-list-heading"><h3>Website tests</h3><span>Result &amp; points</span></div>
                    <p className="rd-test-point-note">Earned and missed points describe this audit. Changes are measured when you run it again.</p>
                    <div className="rd-test-buttons">
                      {checks.map(check => {
                        const result = resultForTest(check);
                        return (
                          <button key={check.id} type="button" className="rd-test-button"
                            aria-pressed={selected?.id === check.id} aria-controls="selected-test-result"
                            onClick={() => setSelectedId(check.id)}>
                            <span className="rd-test-name">{check.copy.name}</span>
                            <span className="rd-test-summary">
                              <span className={'rd-test-result rd-test-' + result.toLowerCase().replaceAll(' ', '-')}>{result}</span>
                              <TestPoints check={check} />
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div id="selected-test-result">{selected && <TestFinding check={selected} />}</div>
                </div>
              ) : <p>The audit did not return individual test results for this page.</p>}
            </section>

            {finalScore ? (
              <section className="rd-section">
                <details className="rd-measure">
                  <summary><span><strong>View overall score</strong></span><span>Expand ↓</span></summary>
                  <div className="rd-score-grid">
                    <div><span>OVERALL</span><strong>{formatPoints(finalScore.total)}<small> / 100</small></strong></div>
                    <div><span>WEBSITE STRUCTURE</span><strong>{formatPoints(finalScore.structure)}<small> / 40</small></strong></div>
                    <div><span>PRODUCT CONTENT</span><strong>{formatPoints(finalScore.content)}<small> / 60</small></strong></div>
                  </div>
                </details>
              </section>
            ) : <p className="rd-live-note">An overall score is unavailable until all applicable tests can be completed. The results and points above are available to review now.</p>}

            <section className="rd-section rd-scope">
              <h2>About this report</h2>
              <p>Created {date(assessment.createdAt)} · Available until {date(assessment.expiresAt)}.</p>
              <p>{assessment.cache.hit ? 'This is a saved result, valid until ' + date(assessment.cache.validUntil) + '.' : 'This audit checked the page for this request.'}</p>
              {report.coverage.limitations.length > 0 && (
                <details>
                  <summary>What this audit could assess</summary>
                  {report.coverage.limitations.map((item, index) => <p key={index}>{item}</p>)}
                </details>
              )}
              {model.warnings.map((item, index) => <p key={index}>{item}</p>)}
            </section>
          </>
        ) : (
          <section className="rd-section rd-state">
            <h2>{displayStatus}</h2>
            {model.warnings.map((item, index) => <p key={index}>{item}</p>)}
            {!model.warnings.length && <p>{assessment.status === 'pending' ? 'We’re checking the product page. Your test results will appear here when the audit finishes.' :
              assessment.error?.message || 'No report was returned. Try another public product page or try again later.'}</p>}
            <button className="rd-live-retry" onClick={onBack}>Check another page ↗</button>
          </section>
        )}
      </main>
      <footer className="rd-footer">
        <span>answerable<i>.</i></span><a href="#top">Back to top ↑</a>
      </footer>
    </div>
  );
}
