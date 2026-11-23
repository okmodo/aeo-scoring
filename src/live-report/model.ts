import { availablePointsForCheck, getTestCopy, validateReport, type TestCopy } from '../../contracts/report-contract.mjs'
import type { Assessment, AuditReport, CheckComponent, Evidence, Subcheck } from '../../contracts/v1/types'

type ExtendedSubcheck = Subcheck & { earnedPoints?: number; availablePoints?: number; exclusion?: string | null; presentation?: TestCopy }
export type CheckDetail = {
  id: string
  copy: { name: string; description: string; improve: string; fullCredit: string | null; group?: string; type?: 'Structural' | 'Data' }
  guidance: string | null
  status: Subcheck['status']
  points: number | null
  earnedPoints?: number
  verifiedMissedPoints?: number
  maxPoints: number
  availablePoints: number | null
  fraction: number | null
  reason: string | null
  exclusion: string | null
  evidence: Evidence[]
  missingEvidenceIds: string[]
  fullCredit: string | null
  components: (CheckComponent & { evidence: Evidence[]; missingEvidenceIds: string[] })[]
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

export function buildLiveReportModel(assessment: Assessment): LiveReportModel {
  const report = assessment.report
  const counts = { measured: 0, partial: 0, zero: 0, unmeasured: 0, excluded: 0 }
  const warnings: string[] = []
  if (!report) return { assessment, report, finalScore: null, counts, checks: [], fixes: [], warnings }
  const validation = validateReport(report)
  if (!validation.valid) {
    warnings.push('This report uses a version or test result that this app cannot display safely. Please run a new audit or contact support.')
    return { assessment, report: null, finalScore: null, counts, checks: [], fixes: [], warnings }
  }
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
  const checks: CheckDetail[] = report.criteria.flatMap(criterion => criterion.subchecks.map(raw => {
    const check: ExtendedSubcheck = raw
    if (check.status === 'not_applicable') counts.excluded++
    else if (check.status !== 'measured' || check.fraction === null || !Number.isFinite(check.fraction)) counts.unmeasured++
    else if (check.fraction <= 0) counts.zero++
    else if (check.fraction < 1) counts.partial++
    else counts.measured++
    const resolved = resolve(check.evidenceIds)
    const copy = report.rubricVersion === '3.0.0'
      ? getTestCopy(report.rubricVersion, check.id)!
      : check.presentation ?? getTestCopy(report.rubricVersion, check.id)!
    const measuredComponents = check.components?.filter(component => component.status === 'measured') ?? []
    return {
      id: check.id, copy, guidance: null, status: check.status, points: check.points,
      earnedPoints: measuredComponents.length ? check.earnedPoints : undefined,
      verifiedMissedPoints: measuredComponents.reduce((sum, component) =>
        sum + (component.availablePoints ?? component.maxPoints) - (component.points ?? 0), 0),
      maxPoints: check.maxPoints, availablePoints: check.availablePoints ?? availablePointsForCheck(report, check.id), fraction: check.fraction,
      reason: check.reason, exclusion: check.exclusion ?? null, ...resolved,
      fullCredit: copy.fullCredit,
      components: (check.components ?? []).map(component => ({ ...component, ...resolve(component.evidenceIds) })),
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
  for (const fix of fixes) {
    for (const check of fix.checks) {
      if (!check.guidance) check.guidance = fix.condition || fix.title
    }
  }
  if (checks.some(check => check.missingEvidenceIds.length) || fixes.some(fix => fix.missingEvidenceIds.length)) {
    warnings.push('Some referenced evidence is unavailable or synthetic; unsupported details are withheld.')
  }
  if (fixes.some(fix => fix.checks.some(check => check.status === 'measured' && check.evidence.length === 0))) {
    warnings.push('Some affected checks have no available source evidence; specific findings cannot be verified.')
  }
  if (fixes.some((fix, index) => fix.checks.length !== report.fixes[index].checkIds.length)) {
    warnings.push('Some referenced checks are unavailable; their details are withheld.')
  }
  const published = assessment.status === 'complete' || assessment.status === 'incomplete'
  const earnedScore = published && report.scoreBasis === 'earned_points'
  const legacyScore = assessment.status === 'complete' && report.status === 'complete' && counts.unmeasured === 0
  const finalScore = earnedScore || legacyScore ? report.score : null
  return { assessment, report, finalScore, counts, checks, fixes, warnings }
}
