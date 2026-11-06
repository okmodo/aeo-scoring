// These checks deliberately report only positive, unambiguous evidence. The caller
// must first establish that this Product is the unique selected page entity.
const currencies = new Set(Intl.supportedValuesOf('currency'));
const availability = new Set(['InStock', 'OutOfStock', 'PreOrder', 'PreSale', 'BackOrder', 'Discontinued', 'InStoreOnly', 'OnlineOnly', 'LimitedAvailability', 'SoldOut']);
const own = (object, key) => Object.hasOwn(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && /[\p{L}\p{N}]/u.test(value);
const schemaType = (value, type) => value === type || value === `https://schema.org/${type}` || value === `http://schema.org/${type}`;

function validGtin(value, length) {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || ![8, 12, 13, 14].includes(value.length) || (length && value.length !== length)) return false;
  const digits = [...value].map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((total, digit, i) => total + digit * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - sum % 10) % 10 === check;
}

function offerCheck(record, sourceUrl) {
  const offer = record.offers;
  if (!object(offer) || !schemaType(offer['@type'], 'Offer') || own(offer, '@context')) return;
  // Market, product, price and time qualifiers require context we do not inspect.
  if (['itemOffered', 'areaServed', 'eligibleRegion', 'availableAtOrFrom', 'priceSpecification', 'priceValidUntil', 'availabilityStarts', 'availabilityEnds', 'businessFunction'].some(key => own(offer, key))) return;
  if (own(offer, 'url')) {
    try {
      if (typeof offer.url !== 'string' || typeof sourceUrl !== 'string' || new URL(offer.url, sourceUrl).href !== new URL(sourceUrl).href) return;
    } catch { return; }
  }
  const price = offer.price;
  const validPrice = (typeof price === 'number' && Number.isFinite(price) && price >= 0) ||
    (typeof price === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(price));
  const currency = offer.priceCurrency;
  const state = typeof offer.availability === 'string' ? offer.availability.replace(/^https?:\/\/schema\.org\//, '') : '';
  const hasPrice = own(offer, 'price');
  const hasCurrency = own(offer, 'priceCurrency');
  const hasAvailability = own(offer, 'availability');
  if ((hasPrice && !validPrice) || (hasCurrency && !currencies.has(currency)) || (hasAvailability && !availability.has(state))) return;
  // An orphan price or currency is incomplete, rather than a confirmed absence.
  if (hasPrice !== hasCurrency) return;
  if (hasPrice && hasAvailability) return { fraction: 1, excerpt: 'One Offer supplies a price, recognized currency and schema.org availability.', currency };
  if (hasPrice) return { fraction: 0.5, excerpt: 'One Offer supplies a price and recognized currency; availability is absent from the Offer.', currency };
  if (hasAvailability) return { fraction: 0.5, excerpt: 'One Offer supplies schema.org availability; price and currency are absent from the Offer.' };
}

function identifierCheck(record) {
  const brand = record.brand;
  const validBrand = text(brand) || (object(brand) && !own(brand, '@context') && schemaType(brand['@type'], 'Brand') && text(brand.name));
  if (own(record, 'brand') && !validBrand) return;
  const gtins = [['gtin', null], ['gtin8', 8], ['gtin12', 12], ['gtin13', 13], ['gtin14', 14]].filter(([key]) => own(record, key));
  // Multiple or malformed identifiers cannot establish which identifier applies.
  if (gtins.length > 1) return;
  if (gtins.length === 1) {
    const [key, length] = gtins[0];
    if (!validGtin(record[key], length)) return;
    if (validBrand) return { fraction: 1, excerpt: 'Product supplies a brand and a GTIN with a valid format and check digit.' };
    return;
  }
  if (own(record, 'mpn')) {
    if (!text(record.mpn)) return;
    if (validBrand) return { fraction: 1, excerpt: 'Product supplies a brand and manufacturer part number.' };
    return;
  }
  if (own(record, 'sku') && text(record.sku)) return validBrand
    ? { fraction: 0.75, excerpt: 'Product supplies a brand and merchant SKU; a manufacturer identifier was not established.' }
    : { fraction: 0.25, excerpt: 'Product supplies a merchant SKU; brand is absent from the record and a manufacturer identifier was not established.' };
}

export function scoreProductFields(record, sourceUrl) {
  if (!object(record)) return {};
  const result = {};
  const offer = offerCheck(record, sourceUrl);
  const identifiers = identifierCheck(record);
  if (offer) result['S2.offer'] = offer;
  if (identifiers) result['S2.identifiers'] = identifiers;
  return result;
}
