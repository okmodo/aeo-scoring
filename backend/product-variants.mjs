import { scoreProductFields } from './product-fields.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const dimensions = new Set(['color', 'size', 'material', 'pattern']);
const typeIs = (value, type) => value === type || value === `https://schema.org/${type}` || value === `http://schema.org/${type}`;
const dimension = value => typeof value === 'string' ? value.replace(/^https?:\/\/schema\.org\//, '') : '';
const valueIsValid = value => typeof value === 'string' && value.trim().length > 0 &&
  value.trim().length <= 100 && /[\p{L}\p{N}]/u.test(value) && !/[<>\p{Cc}\p{Cf}]/u.test(value);
const structuralKeywords = ['@id', '@graph', '@included', '@nest', '@reverse'];

// The caller establishes that this is the unique supported page ProductGroup.
// This intentionally accepts only bounded, inline, independently associated variants.
export function selectProductVariant(group, sourceUrl) {
  if (!object(group) || !typeIs(group['@type'], 'ProductGroup') ||
      [...structuralKeywords, 'offers', 'isVariantOf'].some(key => own(group, key))) return null;
  if (own(group, '@context') && !['https://schema.org', 'https://schema.org/', 'http://schema.org', 'http://schema.org/'].includes(group['@context'])) return null;
  const rawDimensions = Array.isArray(group.variesBy) ? group.variesBy : [group.variesBy];
  const keys = rawDimensions.map(dimension);
  if (!keys.length || keys.length > dimensions.size || keys.some(key => !dimensions.has(key)) || new Set(keys).size !== keys.length) return null;
  if (!Array.isArray(group.hasVariant) || group.hasVariant.length < 2 || group.hasVariant.length > 8) return null;
  let page;
  try { page = new URL(sourceUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password || page.hash) return null;
  const urls = new Set(), combinations = new Set();
  let selectedIndex = -1;
  for (const [index, record] of group.hasVariant.entries()) {
    if (!object(record) || !typeIs(record['@type'], 'Product') ||
        ['@context', ...structuralKeywords, 'isVariantOf', 'hasVariant', 'variesBy'].some(key => own(record, key)) ||
        typeof record.url !== 'string' || !record.url.trim()) return null;
    if (own(record, 'inProductGroupWithID') &&
        (!valueIsValid(group.productGroupID) || record.inProductGroupWithID !== group.productGroupID)) return null;
    let url;
    try { url = new URL(record.url, page); } catch { return null; }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== page.origin || url.username || url.password || url.hash || urls.has(url.href)) return null;
    urls.add(url.href);
    const values = keys.map(key => record[key]);
    if (!values.every(valueIsValid)) return null;
    const combination = JSON.stringify(values.map(value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()));
    if (combinations.has(combination)) return null;
    combinations.add(combination);
    // The nested Offer must explicitly identify the same URL and contain a supported component.
    const offer = record.offers;
    if (!object(offer) || structuralKeywords.some(key => own(offer, key)) || typeof offer.url !== 'string' || !offer.url.trim()) return null;
    let offerUrl;
    try { offerUrl = new URL(offer.url, page); } catch { return null; }
    if (offerUrl.href !== url.href || !scoreProductFields(record, url.href)['S2.offer']) return null;
    if (url.href === page.href) selectedIndex = index;
  }
  if (selectedIndex < 0) return null;
  const record = group.hasVariant[selectedIndex];
  return {
    record,
    selectedIndex,
    variant: Array.from(keys.map(key => `${key}: ${record[key].trim()}`).join(', ')).slice(0, 160).join(''),
    evidence: { fraction: 1, excerpt: 'Inline variants have distinct dimension combinations and URLs, each with a nested offer explicitly associated with its URL.' },
  };
}
