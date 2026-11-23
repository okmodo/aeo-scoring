import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getTestCopy } from '../contracts/report-contract.mjs'
import { buildLiveReportModel } from '../src/live-report/model.ts'
import { summarizeTestPoints } from '../src/live-report/test-copy.ts'

const expected = {
  "S1.readable-html": [
    "Page readability",
    "Structural",
    "Can tools read your product details without clicking?",
    "Checks whether key product facts arrive with the initial page as readable text, without needing extra clicks or interactions."
  ],
  "S1.scope": [
    "Page readability",
    "Structural",
    "Can tools identify the main product on the page?",
    "Checks whether tools can separate the product being sold from recommendations, reviews, navigation, and other products."
  ],
  "S1.configuration": [
    "Page readability",
    "Structural",
    "Do the displayed details match the selected product option?",
    "Checks whether the displayed information clearly belongs to the selected size, color, model, or other option."
  ],
  "S1.supporting-access": [
    "Page readability",
    "Structural",
    "Can shoppers open your product guides and policies?",
    "Checks whether referenced specifications, guides, and policies can be read on the page or through working links."
  ],
  "S2.product-markup": [
    "Product data for search and AI",
    "Structural",
    "Does your page include properly formatted product data for search tools?",
    "Checks whether the page includes product data in formats search and AI tools can read, including correctly formatted product JSON-LD."
  ],
  "S2.product-identity": [
    "Product data for search and AI",
    "Structural",
    "Does your search data identify the correct product and options?",
    "Checks whether the product data identifies the right product, connects its options, and matches the product shown to shoppers."
  ],
  "S2.offer-agreement": [
    "Product data for search and AI",
    "Structural",
    "Do search tools receive the same price and availability shoppers see?",
    "Checks whether the product data links to the correct product or option and matches its displayed price, currency, and availability."
  ],
  "S2.identifiers": [
    "Product data for search and AI",
    "Structural",
    "Are your product identification codes correct?",
    "Checks whether applicable identifiers, such as a barcode, manufacturer part number, or SKU, are valid and belong to the right product or option."
  ],
  "S2.optional-claims": [
    "Product data for search and AI",
    "Structural",
    "Do extra claims in your search data match your page?",
    "Checks whether additional claims in the product data agree with what shoppers can see on the page."
  ],
  "S4.page-labels": [
    "Easy-to-find details",
    "Structural",
    "Do your page title and headings clearly label the product and its details?",
    "Checks whether the title and main heading identify the product and whether section labels make its details easy to find."
  ],
  "S4.image-alternatives": [
    "Easy-to-find details",
    "Structural",
    "Do your product images have useful text descriptions?",
    "Checks whether informative product images include text descriptions that explain what they show."
  ],
  "S5.crawler-access": [
    "Page discovery",
    "Structural",
    "Does your website allow access by search and AI tools?",
    "Checks whether the website’s crawler rules allow the search and AI tools included in this audit to access the product URL."
  ],
  "S5.sitemap": [
    "Page discovery",
    "Structural",
    "Is your product page listed in a working sitemap?",
    "Checks whether the website has a readable sitemap that lists this product page or its verified preferred URL."
  ],
  "S5.llms-txt": [
    "Page discovery",
    "Structural",
    "Does your website provide an information guide for AI tools?",
    "Checks whether the website provides an llms.txt file that explains the site and links to useful, working resources."
  ],
  "C1.identity-explanation": [
    "Product explanation and choice",
    "Data",
    "Is it clear what your product is and what it does?",
    "Checks whether the page identifies the product, includes its brand or model where relevant, and specifically explains what it does."
  ],
  "C1.options-selection": [
    "Product explanation and choice",
    "Data",
    "Can shoppers choose an option and see what’s included?",
    "Checks whether shoppers can understand the selected option, what comes with their purchase, and how to choose the right option."
  ],
  "C1.essential-specs": [
    "Product explanation and choice",
    "Data",
    "Have you included the specifications shoppers need?",
    "Checks whether the page provides the specifications shoppers need for this type of product, including relevant measurements and units."
  ],
  "C1.supporting-details": [
    "Product explanation and choice",
    "Data",
    "Have you explained product care and important precautions?",
    "Checks whether the page provides useful supporting details, care instructions, and relevant restrictions or precautions."
  ],
  "C1.use-compatibility": [
    "Product explanation and choice",
    "Data",
    "Have you explained how to use the product and what it works with?",
    "Checks whether the page explains what the product is suitable for and what it works with, where relevant."
  ],
  "C3.price-stock": [
    "Buying terms",
    "Data",
    "Can shoppers see the price and whether their option is available?",
    "Checks whether shoppers can understand the current price, currency, pricing conditions, and availability of their selected option."
  ],
  "C3.shipping": [
    "Buying terms",
    "Data",
    "Can shoppers understand shipping costs and delivery?",
    "Checks whether applicable shipping information explains delivery coverage, cost or how it is calculated, and delivery guidance."
  ],
  "C3.returns": [
    "Buying terms",
    "Data",
    "Can shoppers understand your return policy?",
    "Checks whether shoppers can understand return eligibility, the return window, and important conditions, including any final-sale restrictions."
  ],
  "C5.consistency": [
    "Consistent facts and supported claims",
    "Data",
    "Do your product details agree across the page?",
    "Checks whether comparable facts agree across the information shoppers see for the same product, option, and buying conditions."
  ],
  "C5.claim-support": [
    "Consistent facts and supported claims",
    "Data",
    "Have you provided support for important product claims?",
    "Checks whether important product claims have relevant supporting information or clear qualifications on the page or in linked sources."
  ]
}
const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/customer-copy/assessment.json', import.meta.url)))

test('approved v3 customer copy and group metadata are complete', () => {
  assert.equal(Object.keys(expected).length, 24)
  assert.equal(new Set(Object.values(expected).map(row => row[0])).size, 7)
  for (const [id, fields] of Object.entries(expected)) {
    const copy = getTestCopy('3.0.0', id)
    assert.deepEqual([copy.group, copy.type, copy.name, copy.description], fields, id)
    assert.ok(copy.improve && copy.fullCredit, id)
  }
  assert.equal(getTestCopy('3.0.0', 'S2.entity'), null)
  assert.notEqual(getTestCopy('2.0.0', 'S2.identifiers').name, expected['S2.identifiers'][2])
})

test('v3 uses approved local copy, actual subtotal and unresolved results', () => {
  const assessment = fixture()
  assessment.report.criteria[0].subchecks[0].presentation = { name: 'Stale wire copy', description: 'stale', improve: 'stale', fullCredit: 'stale' }
  const model = buildLiveReportModel(assessment)
  assert.equal(model.checks.length, 24)
  assert.equal(model.checks[0].copy.name, expected['S1.readable-html'][2])
  assert.equal(model.checks[0].status, 'not_measured')
  assert.equal(model.checks[0].points, null)
  assert.equal(model.checks[0].earnedPoints, 4)
  assert.equal(summarizeTestPoints(model.checks, null, assessment.report.earnedPoints).earned, 94)
  assert.equal(model.finalScore, null)
})

test('v3 report renders groups, labels and server subtotal', async () => {
  const { createServer } = await import('vite')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const React = await import('react')
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { LiveReport } = await vite.ssrLoadModule('/src/live-report/LiveReport.tsx')
    const html = renderToStaticMarkup(React.createElement(LiveReport, { assessment: fixture(), onBack() {} }))
    for (const group of new Set(Object.values(expected).map(row => row[0]))) assert.ok(html.includes(group), group)
    for (const [, type, name] of Object.values(expected)) {
      const escaped = name.replaceAll('&', '&amp;').replaceAll('>', '&gt;').replaceAll('<', '&lt;')
      assert.ok(html.includes(escaped), name)
      assert.ok(html.includes(type), type)
    }
    assert.match(html, /Points so far: 94 of 100/)
    assert.match(html, /Not completed/)
    assert.match(html, /Verified \+4 points so far/)
    assert.match(html, /Some tests could not be completed/)
    assert.match(html, /rd-test-category[^>]*>[^<]+ · (Structural|Data)/)
  } finally { await vite.close() }
})
