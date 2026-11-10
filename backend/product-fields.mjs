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

// Complete assessment is only for a uniquely associated, fully read Product.
// Unknown qualifiers and multiple plausible offers remain unmeasured.
const unknown = reason => ({ status: 'not_measured', reason });
const measured = (fraction, excerpt, extra = {}) => ({ status: 'measured', fraction, excerpt, ...extra });
const validPrice = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
  (typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value));
function absoluteMatch(candidate, sourceUrl) {
  try { return typeof candidate === 'string' && typeof sourceUrl === 'string' && new URL(candidate, sourceUrl).href === new URL(sourceUrl).href; }
  catch { return false; }
}
function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}
function selectedMarket(qualifier, context) {
  const value = typeof qualifier === 'string' ? qualifier : object(qualifier) && schemaType(qualifier['@type'], 'Country') ? qualifier.name : null;
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value) && typeof context?.market === 'string' && /^[A-Z]{2}$/.test(context.market)
    ? value === context.market : null;
}
function qualifiers(item, context) {
  if (['@context','itemOffered','availableAtOrFrom','availabilityStarts','availabilityEnds','businessFunction','eligibleQuantity','eligibleCustomerType','eligibleTransactionVolume','validFrom','validThrough','valueAddedTaxIncluded','referenceQuantity','billingDuration','billingIncrement','unitCode','unitText'].some(key => own(item, key))) return false;
  for (const key of ['areaServed', 'eligibleRegion']) if (own(item, key) && selectedMarket(item[key], context) !== true) return false;
  return true;
}
function completeOffer(record, sourceUrl, observedAt, context) {
  if (!own(record, 'offers') || record.offers == null) return measured(0, 'Product has no valid Offer.');
  let offer = record.offers;
  if (Array.isArray(offer)) {
    const matches = offer.filter(value => object(value) && absoluteMatch(value.url, sourceUrl));
    if (matches.length !== 1) return unknown('Multiple offers cannot be uniquely associated with the selected URL.');
    offer = matches[0];
  }
  if (!object(offer)) return measured(0, 'Product offer is malformed.');
  if (!schemaType(offer['@type'], 'Offer')) return schemaType(offer['@type'], 'AggregateOffer')
    ? unknown('Aggregate offer does not identify the selected configuration.') : measured(0, 'Product offer has no valid Offer type.');
  if (own(offer, 'url') && !absoluteMatch(offer.url, sourceUrl)) return unknown('Offer URL does not identify the audited page.');
  if (!qualifiers(offer, context)) return unknown('Offer qualifiers require market or other context that was not established.');
  let pricing = offer;
  if (own(offer, 'priceSpecification')) {
    const spec = offer.priceSpecification;
    if (Array.isArray(spec) || !object(spec) || !schemaType(spec['@type'], 'UnitPriceSpecification')) return unknown('Price specification is not a uniquely applicable unit price.');
    if (!qualifiers(spec, context) || own(spec, 'priceValidUntil')) return unknown('Price specification qualifiers are not established.');
    if ((own(offer,'price') && own(spec,'price') && String(offer.price) !== String(spec.price)) ||
        (own(offer,'priceCurrency') && own(spec,'priceCurrency') && offer.priceCurrency !== spec.priceCurrency)) return unknown('Offer and price specification conflict.');
    pricing = { price: spec.price ?? offer.price, priceCurrency: spec.priceCurrency ?? offer.priceCurrency };
  }
  if (context?.currency && pricing.priceCurrency && context.currency !== pricing.priceCurrency) return unknown('Price currency does not match the established currency context.');
  let priceOk = validPrice(pricing.price) && currencies.has(pricing.priceCurrency), expired = false;
  if (own(offer, 'priceValidUntil')) {
    const end = isoDate(offer.priceValidUntil);
    const observed = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
    if (end === null) priceOk = false;
    else if (!Number.isFinite(observed)) return unknown('Offer expiry cannot be assessed without an observation date.');
    else if (observed >= end + 86400000) { priceOk = false; expired = true; }
  }
  const state = typeof offer.availability === 'string' ? offer.availability.replace(/^https?:\/\/schema\.org\//, '') : '';
  const availabilityOk = availability.has(state);
  const fraction = (Number(priceOk) + Number(availabilityOk)) / 2;
  const excerpt = expired ? `Offer price expired on ${offer.priceValidUntil}; ${availabilityOk ? 'availability is valid' : 'availability is absent or invalid'}.`
    : `Offer price and currency are ${priceOk ? 'valid' : 'absent or invalid'}; availability is ${availabilityOk ? 'valid' : 'absent or invalid'}.`;
  return measured(fraction, excerpt, priceOk ? { currency: pricing.priceCurrency } : {});
}
function completeIdentifiers(record) {
  const brand = record.brand;
  const brandOk = text(brand) || (object(brand) && !own(brand, '@context') && schemaType(brand['@type'], 'Brand') && text(brand.name));
  const keys = [['gtin', null], ['gtin8',8], ['gtin12',12], ['gtin13',13], ['gtin14',14]].filter(([key]) => own(record,key));
  const valid = keys.filter(([key, length]) => validGtin(record[key], length)).map(([key]) => record[key].padStart(14,'0'));
  if (new Set(valid).size > 1 || (keys.length > 1 && valid.length !== keys.length)) return unknown('Multiple GTIN fields cannot be reconciled.');
  const manufacturer = valid.length > 0 || text(record.mpn);
  const sku = text(record.sku);
  const fraction = (brandOk ? 0.5 : 0) + (manufacturer ? 0.5 : sku ? 0.25 : 0);
  return measured(fraction, `Brand is ${brandOk ? 'valid' : 'absent or invalid'}; ${manufacturer ? 'a manufacturer identifier is valid' : sku ? 'only a merchant SKU is valid' : 'no valid manufacturer identifier or merchant SKU was found'}.`);
}
export function assessCompleteProductFields(record, sourceUrl, { observedAt, context } = {}) {
  if (!object(record)) return { 'S2.offer': unknown('Product record is unavailable.'), 'S2.identifiers': unknown('Product record is unavailable.') };
  return { 'S2.offer': completeOffer(record, sourceUrl, observedAt, context), 'S2.identifiers': completeIdentifiers(record) };
}
