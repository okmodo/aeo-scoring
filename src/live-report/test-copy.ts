import type { CheckDetail } from './model';

export function resultForTest(check: CheckDetail): 'Pass' | 'Fail' | 'Not completed' | 'Not applicable' {
  if (check.status === 'not_applicable') return 'Not applicable';
  if (check.status !== 'measured' || check.fraction == null || check.points == null ||
      !Number.isFinite(check.fraction) || !Number.isFinite(check.points)) return 'Not completed';
  return check.fraction >= 1 ? 'Pass' : 'Fail';
}

export function pointsForTest(check: CheckDetail) {
  const result = resultForTest(check);
  if (result === 'Not completed' || result === 'Not applicable') return null;
  return {
    earned: check.points!,
    missed: Math.max(0, (check.availablePoints ?? check.maxPoints) - check.points!),
    available: check.availablePoints ?? check.maxPoints,
  };
}

export function formatPoints(value: number): string {
  return new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(value);
}

const findingTranslations: Record<string, string> = {
  'Product has no valid Offer.': 'No valid product offer was found in the information supplied to search and AI tools.',
  'Brand is absent or invalid; only a merchant SKU is valid.': 'The product record has a valid store SKU, but its brand is missing or could not be verified.',
  'The product has configuration controls but no verified structured variant associations.': 'The page offers product choices, but the product record does not show how those choices connect to their offers.',
  'Available evidence does not establish this check.': 'The page information available to this audit was not enough to complete this test.',
  'The evidence does not establish this assessment.': 'The available information was not enough to complete this test.',
  'At least one attribute could not be assessed.': 'The audit could not verify at least one product detail needed for this test.',
  'A category question or its condition could not be assessed.': 'The audit could not verify an answer or the conditions that apply to a shopper’s question.',
  'Comparable shopper-visible facts with the same product and configuration were not established.': 'The audit could not find enough comparable facts for the same product option to check that they agree.',
};

export function readableFinding(value: string): string {
  if (/^Observed invalid values:\s*material=\.\s*$/i.test(value.trim())) {
    return 'The product’s material information was missing or could not be read as a valid value.';
  }
  if (/^(?:the )?material (?:attribute|field|value) (?:is |was )?invalid\.?$/i.test(value.trim())) {
    return 'The audit could not verify the product’s material information.';
  }
  return findingTranslations[value] ?? value;
}

type Finding = { text: string; label: 'Audit finding' | 'From your website' };

export function findingsForTest(check: CheckDetail): Finding[] {
  const result = resultForTest(check);
  const findings: Finding[] = [];
  const reason = check.reason || check.exclusion;
  if (reason) findings.push({ text: readableFinding(reason), label: 'Audit finding' });
  for (const item of check.evidence) {
    const text = item.excerpt;
    if (!text.trim()) continue;
    findings.push({
      text: item.kind === 'source_excerpt' ? text : readableFinding(text),
      label: item.kind === 'source_excerpt' ? 'From your website' : 'Audit finding',
    });
  }
  if (findings.length) return findings.filter((item, index) =>
    findings.findIndex(other => other.text === item.text && other.label === item.label) === index);
  let text = 'The audit returned a result and points, but did not include a specific website finding for this test.';
  if (result === 'Not applicable') text = 'This test does not apply to the product in this assessment.';
  if (result === 'Not completed') text = 'The audit did not return enough information to complete this test.';
  return [{ text, label: 'Audit finding' }];
}

export function summarizeTestPoints(checks: CheckDetail[], finalTotal: number | null) {
  const total = 100;
  const measured = checks.map(pointsForTest).filter(points => points !== null);
  const earned = Math.max(0, Math.min(total, finalTotal ??
    measured.reduce((sum, points) => sum + points.earned, 0)));
  const missed = finalTotal !== null ? total - earned :
    Math.max(0, Math.min(total - earned, measured.reduce((sum, points) => sum + points.missed, 0)));
  return { earned, missed, unscored: Math.max(0, total - earned - missed), total };
}
