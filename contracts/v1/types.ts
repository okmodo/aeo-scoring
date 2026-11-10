// The backend owns this proposed wire contract. Keep frontend view models separate.
export type AssessmentStatus = 'pending' | 'complete' | 'incomplete' | 'unable_to_assess'
export type CheckStatus = 'measured' | 'not_measured' | 'not_applicable'
export type Pillar = 'structure' | 'content'

export interface Submission {
  url: string
}

export interface Problem {
  code: string
  message: string
  retryAfterSeconds: number | null
}

export interface Evidence {
  id: string
  url: string
  method: 'raw' | 'rendered' | 'synthetic'
  kind: 'source_excerpt' | 'derived_observation'
  observedAt: string
  location: string
  excerpt: string
}

export interface Subcheck {
  id: string
  maxPoints: number
  availablePoints?: number
  status: CheckStatus
  fraction: number | null
  points: number | null
  evidenceIds: string[]
  reason: string | null
}

export interface Criterion {
  id: string
  pillar: Pillar
  maxPoints: number
  points: number
  complete: boolean
  subchecks: Subcheck[]
}

export interface PriorityFix {
  id: string
  title: string
  owner: string
  checkIds: string[]
  evidenceIds: string[]
  recoverablePoints: number | null
  condition: string
}

export interface AuditReport {
  status: 'complete' | 'incomplete'
  rubricVersion: string
  engineVersion?: string
  categoryVersion?: string
  category: string | null
  productName: string | null
  variant: string | null
  market: string | null
  currency: string | null
  score: { total: number; structure: number; content: number } | null
  earnedPoints: number
  criteria: Criterion[]
  evidence: Evidence[]
  fixes: PriorityFix[]
  coverage: {
    semantic?: { model: string; version: string }
    measured: number
    notMeasured: number
    notApplicable?: number
    total: number
    category: string | null
    extraction: { html: boolean; bodyText: boolean; usable: boolean; visibility: 'unknown'; jsonLdTruncated: boolean } | null
    limitations: string[]
  }
}

export interface Assessment {
  version: '1'
  id: string
  status: AssessmentStatus
  statusUrl: string
  submittedUrl: string
  assessedUrl: string | null
  createdAt: string
  completedAt: string | null
  expiresAt: string
  cache: { hit: boolean; validUntil: string | null }
  report: AuditReport | null
  error: Problem | null
}

export interface ErrorResponse {
  version: '1'
  error: Problem
}
