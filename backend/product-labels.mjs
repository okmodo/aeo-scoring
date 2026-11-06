// The caller establishes that the Product is uniquely associated with the URL.
function label(value) {
  if (typeof value !== 'string' || value.length > 300 || /[<>\u0000-\u001f\u007f]/u.test(value)) return null;
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
  return /[\p{L}\p{N}]/u.test(normalized) ? normalized : null;
}

function includesLabel(text, part) {
  if (!part) return false;
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'u').test(text);
}

export function scoreProductLabels(product, labels) {
  const name = label(product.name);
  const model = label(product.model);
  const heading = label(labels?.mainH1);
  if (!name || heading !== name || !model || model.length < 4 || !/\p{L}/u.test(model) ||
      !/\p{N}/u.test(model) || !includesLabel(name, model)) return {};

  const result = {};
  const title = label(labels?.title);
  if (title && (title === name || title.startsWith(name + ' | ') ||
      title.startsWith(name + ' - ') || title.startsWith(name + ' – ') || title.startsWith(name + ' — '))) {
    result['S4.title'] = {
      fraction: 1,
      excerpt: 'The raw title and main heading identify the associated Product by the same model-specific name.',
      location: 'head title; main h1; associated Product model',
    };
  }

  const brand = product.brand;
  const brandName = label(typeof brand === 'string' ? brand :
    brand?.['@type'] === 'Brand' && !Object.hasOwn(brand, '@context') ? brand.name : null);
  if (brandName && brandName !== model && includesLabel(name, brandName)) {
    result['C1.identity'] = {
      fraction: 1,
      excerpt: 'The raw main heading names the associated Product and explicitly includes its declared brand and model.',
      location: 'main h1; associated Product brand and model',
    };
  }
  return result;
}
