import rubric from '../../config/rubric.v1.json' with { type: 'json' }
import type { Assessment, AuditReport, Evidence, Subcheck } from '../../contracts/v1/types'

type ExtendedSubcheck = Subcheck & { availablePoints?: number; exclusion?: string | null }
export type CheckDetail = {
  id: string
  label: string
  status: Subcheck['status']
  points: number | null
  maxPoints: number
  availablePoints: number | null
  fraction: number | null
  reason: string | null
  exclusion: string | null
  evidence: Evidence[]
  missingEvidenceIds: string[]
  fullCredit: string | null
}
export type FixDetail = {
  id: string
  title: string
  owner: string
  recoverablePoints: number | null
  condition: string
  checks: CheckDetail[]
  evidence: Evidence[]
  missingEvidenceIds: string[]
}
export type LiveReportModel = {
  assessment: Assessment
  report: AuditReport | null
  finalScore: AuditReport['score']
  counts: { measured: number; partial: number; zero: number; unmeasured: number; excluded: number }
  checks: CheckDetail[]
  fixes: FixDetail[]
  warnings: string[]
}

const rubricChecks = new Map(rubric.criteria.flatMap(criterion => criterion.subchecks.map(check => [check.id, check] as const)))
const criterionLabels: Record<string, string> = {
  S1: 'Readable product information', S2: 'Product structured data', S3: 'Page and structured data agreement',
  S4: 'Page organization', S5: 'Crawler access', S6: 'Sitemap', S7: 'llms.txt', S8: 'Agent guidance',
  C1: 'Product explanation', C2: 'Product attributes', C3: 'Purchase information', C4: 'Buyer questions', C5: 'Claim quality',
}
function labelFor(id: string): string {
  const [criterion, ...rest] = id.split('.')
  const detail = rest.join('.').replace(/[-_]/g, ' ')
  const prefix = criterionLabels[criterion] ?? criterion
  return detail ? `${prefix}: ${detail}` : prefix
}

export function buildLiveReportModel(assessment: Assessment): LiveReportModel {
  const report = assessment.report
  const counts = { measured: 0, partial: 0, zero: 0, unmeasured: 0, excluded: 0 }
  const warnings: string[] = []
  if (!report) return { assessment, report, finalScore: null, counts, checks: [], fixes: [], warnings }
  if (report.evidence.some(item => item.method === 'synthetic')) {
    warnings.push('This report contains synthetic test evidence; no live findings are available.')
    return { assessment: { ...assessment, report: null }, report: null, finalScore: null, counts, checks: [], fixes: [], warnings }
  }
  const evidenceById = new Map(report.evidence.filter(item => item.method !== 'synthetic').map(item => [item.id, item]))
  function resolve(ids: string[]) {
    const evidence: Evidence[] = []
    const missingEvidenceIds: string[] = []
    for (const id of ids) {
      const item = evidenceById.get(id)
      if (item) evidence.push(item)
      else missingEvidenceIds.push(id)
    }
    return { evidence, missingEvidenceIds }
  }
  const checks = report.criteria.flatMap(criterion => criterion.subchecks.map(raw => {
    const check: ExtendedSubcheck = raw
    if (check.status === 'not_applicable') counts.excluded++
    else if (check.status !== 'measured' || check.fraction === null || !Number.isFinite(check.fraction)) counts.unmeasured++
    else if (check.fraction <= 0) counts.zero++
    else if (check.fraction < 1) counts.partial++
    else counts.measured++
    const resolved = resolve(check.evidenceIds)
    return {
      id: check.id, label: labelFor(check.id), status: check.status, points: check.points,
      maxPoints: check.maxPoints, availablePoints: check.availablePoints ?? null, fraction: check.fraction,
      reason: check.reason, exclusion: check.exclusion ?? null, ...resolved,
      fullCredit: rubricChecks.get(check.id)?.full ?? null,
    }
  }))
  const checkById = new Map(checks.map(check => [check.id, check]))
  const fixes = report.fixes.map(fix => {
    const resolved = resolve(fix.evidenceIds)
    return { id: fix.id, title: fix.title, owner: fix.owner, recoverablePoints: fix.recoverablePoints,
      condition: fix.condition, checks: fix.checkIds.flatMap(id => {
        const check = checkById.get(id)
        return check ? [check] : []
      }), ...resolved }
  })
  if (checks.some(check => check.missingEvidenceIds.length) || fixes.some(fix => fix.missingEvidenceIds.length)) {
    warnings.push('Some referenced evidence is unavailable or synthetic; unsupported details are withheld.')
  }
  if (fixes.some(fix => fix.checks.some(check => check.status === 'measured' && check.evidence.length === 0))) {
    warnings.push('Some affected checks have no available source evidence; specific findings cannot be verified.')
  }
  if (fixes.some((fix, index) => fix.checks.length !== report.fixes[index].checkIds.length)) {
    warnings.push('Some referenced checks are unavailable; their details are withheld.')
  }
  const finalScore = assessment.status === 'complete' && report.status === 'complete' && counts.unmeasured === 0
    ? report.score : null
  return { assessment, report, finalScore, counts, checks, fixes, warnings }
}
