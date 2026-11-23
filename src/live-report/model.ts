import rubric from '../../config/rubric.v1.json' with { type: 'json' }
import rubricV2 from '../../config/rubric.v2.json' with { type: 'json' }
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
  earnedPoints: number | null
  components: CheckDetail[]
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
  scoreBasis: 'earned_points' | 'legacy' | null
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
const v3Labels: Record<string, string> = {
  S1: 'Page access and readability', S2: 'Product structured data', S4: 'Page organization', S5: 'Discovery and crawler access',
  C1: 'Product information and guidance', C3: 'Purchase information', C5: 'Claim quality',
  'S1.readable-html': 'Readable HTML', 'S1.scope': 'Product page scope', 'S1.configuration': 'Product configuration', 'S1.supporting-access': 'Supporting information access',
  'S2.product-markup': 'Product markup', 'S2.product-identity': 'Product identity', 'S2.offer-agreement': 'Offer agreement', 'S2.identifiers': 'Product identifiers', 'S2.optional-claims': 'Optional claim agreement',
  'S4.page-labels': 'Page labels and organization', 'S4.image-alternatives': 'Image alternatives', 'S5.crawler-access': 'Crawler access', 'S5.sitemap': 'Sitemap', 'S5.llms-txt': 'llms.txt',
  'C1.identity-explanation': 'Product identity and explanation', 'C1.options-selection': 'Options and selection', 'C1.essential-specs': 'Essential specifications', 'C1.supporting-details': 'Supporting details', 'C1.use-compatibility': 'Use and compatibility',
  'S1.delivery': 'HTML delivery', 'S1.readability': 'Readable content', 'S2.json-ld': 'Product JSON-LD', 'S2.syntax': 'Structured data syntax', 'S2.entity': 'Product entity', 'S2.offer': 'Offer data', 'S2.variants': 'Product variants', 'S3.identity': 'Identity agreement', 'S3.price': 'Price agreement', 'S3.availability': 'Availability agreement', 'S3.optional-claims': 'Optional claim agreement',
  'S4.title': 'Page title', 'S4.organization': 'Content organization', 'S5.search': 'Search crawler access', 'S5.ai-retrieval': 'AI crawler access', 'S6.usable': 'Usable sitemap', 'S6.inclusion': 'Sitemap inclusion', 'S7.identity': 'llms.txt identity', 'S7.links': 'llms.txt links',
  'C1.identity': 'Product identity', 'C1.explanation': 'Product explanation', 'C1.configuration': 'Product options', 'C2.essential': 'Essential attributes', 'C2.supporting': 'Supporting attributes', 'C3.price': 'Price', 'C3.availability': 'Availability', 'C4.intended-use': 'Intended use', 'C4.compatibility': 'Compatibility', 'C4.limitations': 'Limitations', 'C4.selection': 'Selection guidance',
  'C3.price-stock': 'Price and availability', 'C3.shipping': 'Shipping', 'C3.returns': 'Returns', 'C5.consistency': 'Consistency', 'C5.claim-support': 'Claim support',
}
const v3Rules = new Map(rubricV2.criteria.flatMap(criterion => criterion.subchecks.map(check => [check.id, check.full] as const)))
v3Rules.set('S2.json-ld', 'On-page initial or rendered HTML contains parseable Schema.org Product or ProductGroup JSON-LD.')
function labelFor(id: string, v3 = false): string {
  if (v3 && v3Labels[id]) return v3Labels[id]
  const [criterion, ...rest] = id.split('.')
  const detail = rest.join('.').replace(/[-_]/g, ' ')
  const prefix = criterionLabels[criterion] ?? criterion
  return detail ? `${prefix}: ${detail}` : prefix
}

export function buildLiveReportModel(assessment: Assessment): LiveReportModel {
  const report = assessment.report
  const counts = { measured: 0, partial: 0, zero: 0, unmeasured: 0, excluded: 0 }
  const warnings: string[] = []
  if (!report) return { assessment, report, finalScore: null, scoreBasis: null, counts, checks: [], fixes: [], warnings }
  if (report.evidence.some(item => item.method === 'synthetic')) {
    warnings.push('This report contains synthetic test evidence; no live findings are available.')
    return { assessment: { ...assessment, report: null }, report: null, finalScore: null, scoreBasis: null, counts, checks: [], fixes: [], warnings }
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
  const v3 = report.rubricVersion.startsWith('3.')
  function detail(check: ExtendedSubcheck, component = false): CheckDetail {
    const resolved = resolve(check.evidenceIds)
    return {
      id: check.id, label: labelFor(check.id, v3), status: check.status, points: check.points,
      maxPoints: check.maxPoints, availablePoints: check.availablePoints ?? null, fraction: check.fraction,
      reason: check.reason, exclusion: check.exclusion ?? null, ...resolved,
      fullCredit: v3 ? (component ? v3Rules.get(check.id) ?? null : null) : rubricChecks.get(check.id)?.full ?? null,
      earnedPoints: check.earnedPoints ?? null,
      components: (check.components ?? []).map(item => detail(item, true)),
    }
  }
  const checks = report.criteria.flatMap(criterion => criterion.subchecks.map(raw => {
    const check: ExtendedSubcheck = raw
    if (check.status === 'not_applicable') counts.excluded++
    else if (check.status !== 'measured' || check.fraction === null || !Number.isFinite(check.fraction)) counts.unmeasured++
    else if (check.fraction <= 0) counts.zero++
    else if (check.fraction < 1) counts.partial++
    else counts.measured++
    return detail(check)
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
  // Older envelopes only published a final score for complete reports. New earned
  // scores are explicitly marked, so incomplete historical scores stay withheld.
  const earnedScore = report.scoreBasis === 'earned_points' && assessment.status !== 'unable_to_assess'
  const legacyScore = assessment.status === 'complete' && report.status === 'complete' && counts.unmeasured === 0
  const finalScore = earnedScore || legacyScore ? report.score : null
  const scoreBasis = finalScore ? (earnedScore ? 'earned_points' : 'legacy') : null
  return { assessment, report, finalScore, scoreBasis, counts, checks, fixes, warnings }
}
