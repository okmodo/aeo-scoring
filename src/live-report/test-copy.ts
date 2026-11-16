import type { CheckDetail } from './model';

type TestCopy = { name: string; description: string; improve: string };

export const testCopy: Record<string, TestCopy> = {
  'S1.identity': { name: 'Product name and selected option', description: 'Can a visitor read the product name and see which option is selected?', improve: 'Make the product name and selected size, colour or other option clear on the page.' },
  'S1.description': { name: 'Readable product description', description: 'Does the page include a product description that can be read directly?', improve: 'Publish a useful product description as readable page text.' },
  'S1.specifications': { name: 'Readable product specifications', description: 'Can visitors read the specifications needed to understand this product?', improve: 'Show the relevant specifications as readable text, with units where needed.' },
  'S1.price': { name: 'Visible price and currency', description: 'Can visitors see the price and the currency they will pay in?', improve: 'Show the verified price and currency for the selected option.' },
  'S1.availability': { name: 'Visible stock availability', description: 'Can visitors see whether the selected option is available?', improve: 'Show the current availability of the selected option.' },
  'S2.entity': { name: 'Product information for search tools', description: 'Can search and AI tools identify the product from the page’s structured product information?', improve: 'Add a valid product record that clearly identifies the product on this page.' },
  'S2.core-properties': { name: 'Product name, description and image for search tools', description: 'Does the product record include a name, description and image?', improve: 'Include the verified product name, description and image in the product record.' },
  'S2.offer': { name: 'Price and stock details for search tools', description: 'Can search and AI tools read the product’s price, currency and availability?', improve: 'Add an offer with the verified price, currency and availability to the product record.' },
  'S2.identifiers': { name: 'Brand and product identifiers', description: 'Does the product record identify the brand and include the applicable product identifiers?', improve: 'Add the verified brand and applicable manufacturer or global product identifiers. Keep the store’s SKU in its own field.' },
  'S2.variants': { name: 'Product options for search tools', description: 'Can search and AI tools match each product option to its correct offer?', improve: 'Connect each supported size, colour or configuration to the correct product record and offer.' },
  'S3.identity': { name: 'Product name agrees across the page', description: 'Do the visible product details and the product record describe the same item and option?', improve: 'Make the product name and option agree in the visible content and product record.' },
  'S3.price': { name: 'Price agrees across the page', description: 'Do the visible price and the price supplied to search tools agree for the same option?', improve: 'Match the current price and currency across the visible page and product record.' },
  'S3.availability': { name: 'Stock availability agrees across the page', description: 'Does the availability shown to visitors agree with the product record?', improve: 'Match the availability across the visible page and product record for the same option.' },
  'S3.optional-claims': { name: 'Product claims agree across the page', description: 'Do product claims agree wherever they appear in the visible content and product record?', improve: 'Review the cited claims and make their meaning and scope consistent.' },
  'S4.title': { name: 'Clear page title and product heading', description: 'Do the page title and main heading clearly identify the product?', improve: 'Use a clear page title and main product heading that identify this product.' },
  'S4.organization': { name: 'Clear headings and specification labels', description: 'Are product details organised under clear headings with readable labels?', improve: 'Group the relevant details under clear headings and label the specifications so shoppers can find them.' },
  'S4.image-alternatives': { name: 'Useful product image descriptions', description: 'Do informative product images have useful text descriptions for people and tools that cannot see them?', improve: 'Give each informative product image an accurate text description. Verify which images need a change in the evidence below.' },
  'S5.search': { name: 'Access for search engines', description: 'Does the website allow the search engines checked by this audit to access this product page?', improve: 'Review the website’s crawler permissions and decide which search engines should be allowed to access the product page.' },
  'S5.ai-retrieval': { name: 'Access for AI answer tools', description: 'Does the website allow the AI retrieval tools checked by this audit to access this product page?', improve: 'Review the website’s crawler permissions against the AI tools you want to allow.' },
  'S6.usable': { name: 'Working website sitemap', description: 'Can the audit find and read a sitemap that helps tools discover the website’s pages?', improve: 'Publish a readable sitemap containing the relevant website pages.' },
  'S6.inclusion': { name: 'Product included in the sitemap', description: 'Does the website’s sitemap include the product page assessed here?', improve: 'Include the correct product URL in a readable sitemap.' },
  'S7.identity': { name: 'Website identity in the AI guide', description: 'Does the website’s llms.txt guide identify the business or website?', improve: 'If you maintain an llms.txt guide, identify the business and website clearly.' },
  'S7.links': { name: 'Useful links in the AI guide', description: 'Does the llms.txt guide link to useful website resources?', improve: 'If you maintain an llms.txt guide, add verified links to the relevant product, category or information pages.' },
  'S8.context': { name: 'Website context for AI tools', description: 'Does the website’s agent guide explain what the business and website provide?', improve: 'If you maintain an agent guide, describe the business and the purpose of its website.' },
  'S8.guidance': { name: 'Clear guidance for AI tools', description: 'Does the website’s agent guide give tools useful instructions for using its information?', improve: 'If you maintain an agent guide, add clear, accurate instructions and links that help AI tools use the website’s information.' },
  'C1.identity': { name: 'Product purpose and audience', description: 'Does the content explain what the product is and who it is for?', improve: 'Explain the product’s purpose and intended audience using verified details.' },
  'C1.explanation': { name: 'Specific product explanation', description: 'Does the description explain this product in useful, specific terms?', improve: 'Explain the product’s relevant features and benefits with concrete, verified details.' },
  'C1.configuration': { name: 'Options and included items explained', description: 'Does the page explain the product’s configurations and what is included?', improve: 'Describe the available configurations and included items clearly.' },
  'C2.essential': { name: 'Essential product details', description: 'Does the page provide the essential details shoppers need for this type of product?', improve: 'Provide the essential product details identified by the findings, including units and scope where needed.' },
  'C2.supporting': { name: 'Additional useful product details', description: 'Does the page include the additional details that help shoppers choose and use this product?', improve: 'Add the supporting product details identified by the findings using verified information.' },
  'C3.price': { name: 'Purchase price explained', description: 'Is the price clear for the product and option being assessed?', improve: 'Clarify the price, currency and any conditions for the selected option.' },
  'C3.availability': { name: 'Stock information explained', description: 'Does the content clearly explain the selected option’s availability?', improve: 'Publish current, option-specific availability information.' },
  'C3.shipping': { name: 'Shipping cost and delivery details', description: 'Can shoppers understand the applicable shipping cost and delivery information?', improve: 'Provide verified shipping costs, delivery information and the conditions that apply.' },
  'C3.returns': { name: 'Returns policy explained', description: 'Can shoppers understand the return window, eligibility and important conditions?', improve: 'Make the applicable return window, eligibility and conditions clear.' },
  'C4.intended-use': { name: 'Questions about product use answered', description: 'Does the page answer the relevant questions about how and when to use the product?', improve: 'Answer the product-use questions identified in the findings with specific, verified information.' },
  'C4.compatibility': { name: 'Compatibility questions answered', description: 'Does the page answer the relevant questions about what the product works with?', improve: 'Explain relevant compatibility requirements and restrictions.' },
  'C4.limitations': { name: 'Product limitations explained', description: 'Does the page explain relevant limitations and situations where the product is unsuitable?', improve: 'Describe the relevant limitations and conditions identified in the findings.' },
  'C4.selection': { name: 'Help choosing the right option', description: 'Does the page help shoppers choose the appropriate size, fit or other product option?', improve: 'Add verified guidance that helps shoppers choose the correct option.' },
  'C5.consistency': { name: 'Consistent product facts', description: 'Do comparable product facts agree within the same product and option?', improve: 'Resolve the conflicting facts identified in the findings and verify the correct value.' },
  'C5.claim-support': { name: 'Evidence for product claims', description: 'Are important product claims supported or clearly qualified?', improve: 'Support the cited claims with relevant evidence or explain the conditions and limits.' },
};

export function copyForTest(id: string): TestCopy {
  return testCopy[id] ?? {
    name: 'Additional website test',
    description: 'This audit returned an additional test for the product page.',
    improve: 'Review the finding and source details before making changes.',
  };
}

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
  return findingTranslations[value] ?? value;
}

type Finding = { text: string; label: 'Audit finding' | 'From your website' };

export function findingsForTest(check: CheckDetail): Finding[] {
  const result = resultForTest(check);
  const findings: Finding[] = [];
  const reason = check.reason || check.exclusion;
  if (reason) findings.push({ text: readableFinding(reason), label: 'Audit finding' });
  for (const item of check.evidence) {
    const text = item.excerpt.trim();
    if (!text) continue;
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
