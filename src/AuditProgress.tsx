import { useEffect, useRef } from 'react';
import type { Assessment } from '../contracts/v1/types';
import { buildLiveReportModel } from './live-report/model';
import './audit-progress.css';

export const auditSteps = [
  ['Page download', 'Retrieve your product page.'],
  ['Data extraction', 'Read the product information and website evidence.'],
  ['AI Review', 'Review the available evidence where assessment is supported.'],
  ['Score Card Building', 'Organize findings, points and recommended changes.'],
  ['Audit complete', 'Open your report when processing finishes.'],
] as const;

export function AuditProgress({ accepted, onCancel }: { accepted: boolean; onCancel: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <main className="audit-progress" aria-labelledby="audit-progress-heading">
    <div className="audit-progress-card">
      <div className="audit-progress-eyebrow"><span className="audit-progress-spinner" aria-hidden="true" />AUDIT IN PROGRESS</div>
      <div role="status" aria-live="polite" aria-atomic="true">
        <h1 id="audit-progress-heading" tabIndex={-1} ref={heading}>{accepted ? 'Your audit is running.' : 'Starting your audit.'}</h1>
        <p>{accepted ? 'Your page is being processed. Your report will open automatically when it’s ready.' : 'Connecting securely to the audit service. Your report will open here when it’s ready.'}</p>
      </div>
      <div className="audit-progress-track" role="progressbar" aria-label="Audit processing"><span /></div>
      <ol className="audit-progress-steps" aria-label="Audit workflow">
        {auditSteps.map(([name, description], index) => <li key={name}>
          <span className="audit-progress-number" aria-hidden="true">{index + 1}</span>
          <div><h2>{name}</h2><p>{description}</p></div>
        </li>)}
      </ol>
      <p className="audit-progress-note">Your report may include partial findings when some checks cannot be completed.</p>
      <button type="button" className="audit-progress-cancel" onClick={onCancel}>Cancel waiting</button>
      <p className="audit-progress-note">An audit already started may continue after you leave this screen.</p>
    </div>
  </main>;
}

export function AuditCompletion({ assessment }: { assessment: Assessment }) {
  if (assessment.status === 'pending') return null;
  const ready = buildLiveReportModel(assessment).report !== null && ['complete', 'incomplete'].includes(assessment.status);
  return <div className={'audit-completion' + (ready ? '' : ' audit-completion-failed')} role="status">
    <strong>{ready ? 'Audit complete' : 'Audit could not be completed'}</strong>
    <span>{ready ? assessment.status === 'incomplete' ? 'Processing has finished. Your report includes partial findings; some tests could not be completed.' : 'Your report is ready below.' : 'No final score is available. Review the message below before trying again.'}</span>
  </div>;
}
