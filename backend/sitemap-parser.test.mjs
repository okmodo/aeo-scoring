import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSitemap } from './sitemap-parser.mjs';

const ns = 'http://www.sitemaps.org/schemas/sitemap/0.9';
test('reads only sitemap loc children and resolves namespace prefixes and entities', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><s:urlset xmlns:s="${ns}" xmlns:x="urn:ext"><s:url><s:loc>https://example.com/?a=1&amp;b=2</s:loc><x:loc>https://wrong/</x:loc></s:url><s:url><s:loc><![CDATA[https://example.com/two]]></s:loc></s:url></s:urlset>`;
  assert.deepEqual(parseSitemap(xml), { kind: 'urlset', locations: ['https://example.com/?a=1&b=2', 'https://example.com/two'] });
  assert.deepEqual(parseSitemap(`<sitemapindex xmlns="${ns}"><sitemap><loc>https://example.com/map.xml</loc></sitemap></sitemapindex>`), { kind: 'sitemapindex', locations: ['https://example.com/map.xml'] });
});
test('fails closed on unsupported or malformed XML', () => {
  const invalid = [
    '<html><loc>https://example.com</loc></html>',
    '<urlset><url><loc>https://example.com</loc></url></urlset>',
    `<!DOCTYPE urlset [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset xmlns="${ns}"><url><loc>&x;</loc></url></urlset>`,
    `<urlset xmlns="${ns}"><url><loc>&unknown;</loc></url></urlset>`,
    `<urlset xmlns="${ns}"><url><loc>foo</url></loc></urlset>`,
    `<urlset xmlns="${ns}"><url><loc>foo<b>bar</b></loc></url></urlset>`,
    `<urlset xmlns="${ns}"><url><loc>foo</loc><loc>bar</loc></url></urlset>`,
    `<urlset xmlns="${ns}" xmlns="${ns}"/>`,
    `<urlset xmlns="${ns}"/><urlset xmlns="${ns}"/>`,
    `<urlset xmlns="${ns}"><!-- bad -- comment --></urlset>`,
    `<urlset xmlns="${ns}"><x:url/></urlset>`,
    `<urlset xmlns="${ns}"><url><loc>&#0;</loc></url></urlset>`,
  ];
  for (const xml of invalid) assert.equal(parseSitemap(xml), null, xml);
});
test('enforces entry and nesting limits', () => {
  assert.equal(parseSitemap(`<urlset xmlns="${ns}">${'<url/>'.repeat(501)}</urlset>`), null);
  assert.equal(parseSitemap(`<urlset xmlns="${ns}">${'<x>'.repeat(24)}${'</x>'.repeat(24)}</urlset>`), null);
});

test('rejects incomplete entries and invalid sitemap structure', () => {
  for (const body of [
    '<url><loc>https://example.com/</loc></url><url/>',
    '<url><loc>https://example.com/</loc></url><url><lastmod>2020-01-01</lastmod></url>',
    '<url><loc>https://example.com/</loc></url><other/>',
    'unexpected<url><loc>https://example.com/</loc></url>',
    '<url>unexpected<loc>https://example.com/</loc></url>',
  ]) assert.equal(parseSitemap(`<urlset xmlns="${ns}">${body}</urlset>`), null);
  assert.equal(parseSitemap(`<urlset xmlns="${ns}">${' '.repeat(32_769)}</urlset>`), null);
  assert.equal(parseSitemap(`<urlset xmlns="${ns}">${'<url><loc>https://x/</loc></url>'.repeat(501)}</urlset>`), null);
});

test('rejects malformed declarations, comments, and outside-root entity references', () => {
  const valid = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a</loc></url></urlset>';
  for (const prefix of ['<?xml VERSION="1.0"?>', '<!--bad--->', '&#32;']) {
    assert.equal(parseSitemap(prefix + valid), null);
  }
  assert.equal(parseSitemap('<?xml version="1.0" encoding="utf-8"?>' + valid)?.kind, 'urlset');
});
