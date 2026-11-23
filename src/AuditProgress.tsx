import { useEffect, useRef } from 'react';
import type { Assessment } from '../contracts/v1/types';
import { buildLiveReportModel } from './live-report/model';
import './audit-progress.css';
import { validatedProgress } from './audit';

export const auditSteps = [
  ['retrieval', 'Page download', 'Retrieve your product page.'],
  ['preparation', 'Data extraction', 'Read the product information and website evidence.'],
  ['assessment', 'AI Review', 'Review the available evidence where assessment is supported.'],
  ['scoring', 'Score Card Building', 'Organize findings, points and recommended changes.'],
] as const;

export function AuditProgress({ assessment, onCancel }: { assessment: Assessment | null; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const overflow = document.body.style.overflow;
    element?.showModal();
    document.body.style.overflow = 'hidden';
    heading.current?.focus();
    return () => { element?.close(); document.body.style.overflow = overflow; };
  }, []);
  const progress = assessment ? validatedProgress(assessment.progress, assessment.id) : undefined;
  const queued = progress !== undefined && progress.events.length === 0;
  return <dialog ref={dialog} className="audit-progress" aria-labelledby="audit-progress-heading" aria-describedby="audit-progress-description" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <div className="audit-progress-card">
      <div className="audit-progress-eyebrow"><span className="audit-progress-spinner" aria-hidden="true" />AUDIT IN PROGRESS</div>
      <div role="status" aria-live="polite" aria-atomic="true">
        <h1 id="audit-progress-heading" tabIndex={-1} ref={heading}>{queued ? 'Waiting to start.' : assessment ? 'Your audit is underway.' : 'Starting your audit.'}</h1>
        <p id="audit-progress-description">{queued ? 'Your audit is in the queue. Your report will open automatically when it’s ready.' : assessment ? 'Your report will open automatically when it’s ready.' : 'Connecting securely to the audit service. Your report will open here when it’s ready.'}</p>
      </div>
      <div className="audit-progress-track" role="progressbar" aria-label="Audit processing"><span /></div>
      <ol className="audit-progress-steps" aria-label="Audit workflow">
        {auditSteps.map(([stage, name, description], index) => {
          const event = progress?.events.filter(item => item.stage === stage).reduce<typeof progress.events[number] | undefined>((latest, item) => !latest || item.sequence > latest.sequence ? item : latest, undefined);
          const state = event ? ({ running: 'Active', completed: 'Completed', skipped: 'Skipped', failed: 'Failed' } as const)[event.status] : 'Waiting';
          return <li key={stage} className={progress ? `stage-${state.toLowerCase()}` : undefined}>
            <span className="audit-progress-number" aria-hidden="true">{index + 1}</span>
            <div><h2>{name}</h2><p>{description}</p>{progress && <p className="audit-stage-status">{state}</p>}</div>
          </li>;
        })}
        <li className={progress ? 'stage-waiting' : undefined}>
          <span className="audit-progress-number" aria-hidden="true">5</span>
          <div><h2>Audit complete</h2><p>Open your report when processing finishes.</p>{progress && <p className="audit-stage-status">Waiting</p>}</div>
        </li>
      </ol>
      <p className="audit-progress-note">Your report may include partial findings when some checks cannot be completed.</p>
      <button type="button" className="audit-progress-cancel" onClick={onCancel}>Cancel waiting</button>
      <p className="audit-progress-note">An audit already started may continue after you leave this screen.</p>
    </div>
  </dialog>;
}

export function AuditCompletion({ assessment }: { assessment: Assessment }) {
  if (assessment.status === 'pending') return null;
  const ready = buildLiveReportModel(assessment).report !== null && ['complete', 'incomplete'].includes(assessment.status);
  return <div className={'audit-completion' + (ready ? '' : ' audit-completion-failed')} role="status">
    <strong>{ready ? 'Audit complete' : 'Audit could not be completed'}</strong>
    <span>{ready ? assessment.status === 'incomplete' ? 'Processing has finished. Your report includes partial findings; some tests could not be completed.' : 'Your report is ready below.' : 'No final score is available. Review the message below before trying again.'}</span>
  </div>;
}
