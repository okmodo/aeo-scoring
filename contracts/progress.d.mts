export type ProgressStage = 'retrieval' | 'preparation' | 'assessment' | 'scoring';
export type ProgressStatus = 'running' | 'completed' | 'failed' | 'skipped';
export interface AuditProgress { version: '1'; auditId: string; revision: number; events: {sequence: number; stage: ProgressStage; status: ProgressStatus}[] }
export function auditProgress(input: {auditId: string; queue: {sequence: number; phase: string} | null; pipeline: string | null; prepared: string | null; status: string; report: unknown}): AuditProgress | undefined;
