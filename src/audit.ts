import type { Assessment, ErrorResponse } from '../contracts/v1/types';

export const AUDIT_ORIGIN = 'https://aeo-audit-public-20261105.aeo-scoring-kk7.workers.dev';
export const AUDITS_PATH = '/api/v1/audits';

// Never follow a server-provided URL to another origin or a different route.
export function auditStatusUrl(path: string): string {
  if (!/^\/api\/v1\/audits\/[A-Za-z0-9-]+$/.test(path)) throw new Error('The service returned an invalid report address.');
  return AUDIT_ORIGIN + path;
}
export function pollDelay(attempt: number): number {
  return Math.min(2000 * 2 ** attempt, 10000);
}
export class PreviewPasswordRequired extends Error {
  constructor() {
    super('Enter the shared testing password.');
  }
}

function authorizedFetch(url: string, password: string, init: RequestInit) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer ' + password);
  return fetch(url, { ...init, headers, cache: 'no-store', credentials: 'omit', redirect: 'error' });
}

export async function unlockPreview(password: string, signal: AbortSignal) {
  const res = await authorizedFetch(AUDIT_ORIGIN + '/api/v1/preview-access', password, { method: 'POST', signal });
  if (res.status === 401) throw new Error('That password didn’t match. Try again.');
  if (res.status !== 204) throw new Error('Testing access is unavailable. Try again later.');
}

export async function requestAudit(url: string, password: string, signal: AbortSignal): Promise<Assessment> {
  return response(await authorizedFetch(AUDIT_ORIGIN + AUDITS_PATH, password, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  }));
}

export async function getAudit(path: string, password: string, signal: AbortSignal): Promise<Assessment> {
  return response(await authorizedFetch(auditStatusUrl(path), password, { signal }));
}

async function response(res: Response): Promise<Assessment> {
  if (res.status === 401) throw new PreviewPasswordRequired();
  const body = await res.json() as Assessment | ErrorResponse;
  if (!res.ok) {
    const problem = (body as ErrorResponse).error;
    const retry = problem?.retryAfterSeconds ?? Number(res.headers.get('Retry-After'));
    throw new Error(`${problem?.message || 'The audit service is unavailable.'}${res.status === 429 && retry ? ` Try again in ${retry} seconds.` : ''}`);
  }
  const assessment = body as Assessment;
  if (assessment.version !== '1' || !['pending', 'complete', 'incomplete', 'unable_to_assess'].includes(assessment.status)) throw new Error('The service returned an invalid response.');
  auditStatusUrl(assessment.statusUrl);
  return assessment;
}
