// Tradedoubler product feeds through the publisher "unlimited" service (all raw feed data of one feed id):
//   GET http://api.tradedoubler.com/1.0/productsUnlimited[.xml|.json];fid=<FEED_ID>?token=<TOKEN>&sourceproducturl=true
//   GET http://api.tradedoubler.com/1.0/productsUnlimited/lastUpdated.json;fid=<FEED_ID>?token=<TOKEN>
//       -> {"feedIds":[123],"lastUpdatedTime":"2024-04-17T15:57:00.470742"}
// Documented limit: 3 downloads per 24 hours per feed version (HTTP 429 "Request Quota exceeded" beyond that), so the
// runner asks lastUpdated first and downloads only when the feed changed. `sourceproducturl=true` adds the shop's own
// product URL (<sourceProductUrl>); productUrl is the tracking link.
//
// XML: <result><products><product><name/><description/>... <offers><offer sourceProductId=".." modifiedDate="epoch"><feedId/>
//      <productUrl/><sourceProductUrl/><priceHistory><price currency="EUR" date="epoch">617.28</price></priceHistory>
//      <availability/><inStock/><deliveryTime/><condition/><shippingCost/></offer></offers></product></products></result>
// JSON: { "products": [ { name, offers: [ { productUrl, sourceProductUrl, price | priceHistory, currency, availability,
//         inStock, deliveryTime, ... } ], identifiers: { ean, sku, mpn }, brand } ] }
import { xmlBlocks, parseXml, kid, kids, find, textOf } from './xml.js';
import { parsePriceField, deliveryFromText, normId, normGtin, NEG_STOCK, PRE_STOCK, POS_STOCK } from './common.js';
import { cleanText, berlinDate, parseDeliveryDate } from '../util.js';

export const TD_DAILY_DOWNLOADS = 3;

/** Add sourceproducturl=true when the URL does not carry it. */
export function ensureSourceUrl(url) {
  if (!/api\.tradedoubler\.com/i.test(url) || /sourceproducturl=/i.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'sourceproducturl=true';
}

/** The lastUpdated URL that belongs to a productsUnlimited URL, or null. */
export function lastUpdatedUrl(url) {
  if (!/\/productsUnlimited/i.test(url)) return null;
  return url.replace(/\/productsUnlimited(?:\.xml|\.json)?(?=[;?]|$)/i, '/productsUnlimited/lastUpdated.json').replace(/([?&])sourceproducturl=\w+(&?)/i, (m, a, b) => (b ? a : ''));
}

export async function* xmlProducts(chunks) {
  for await (const block of xmlBlocks(chunks, 'product')) {
    const node = parseXml(block);
    if (node) yield node;
  }
}

/** JSON feed: read it whole (the unlimited JSON is one document) and yield products. */
export async function* jsonProducts(chunks) {
  let text = '';
  for await (const c of chunks) text += c;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('feed:bad_json');
  }
  const list = Array.isArray(data) ? data : data.products ?? [];
  for (const p of list) yield p;
}

/** Availability text + quantity -> flags. Dates ("Available 2026-11-12") in the future mean orderable, not in stock. */
export function tdStock(availability, qty, now) {
  const text = cleanText(availability) ?? '';
  const n = qty === null || qty === undefined || qty === '' ? null : Number(String(qty).replace(/[^\d.-]/g, ''));
  const out = { inStock: false, isPreorder: false, isBackorder: false, stockText: text || null, deliveryEstimate: null };
  const dated = /(\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null;
  if (dated && dated > berlinDate(now)) {
    return { ...out, inStock: true, isPreorder: PRE_STOCK.test(text), isBackorder: !PRE_STOCK.test(text), deliveryEstimate: dated };
  }
  if (PRE_STOCK.test(text)) return { ...out, inStock: true, isPreorder: true };
  if (NEG_STOCK.test(text)) return out;
  // Doubt never makes a restock: text says "In stock" but the count says 0 (or less) means no stock.
  if (n !== null && Number.isFinite(n) && n <= 0) return out;
  if (POS_STOCK.test(text) || (dated && dated <= berlinDate(now))) return { ...out, inStock: true };
  if (n !== null && Number.isFinite(n) && n > 0) return { ...out, inStock: true };
  return out;
}

function latestPrice(offerNode) {
  const hist = find(offerNode, 'priceHistory');
  const prices = hist ? kids(hist, 'price') : kids(offerNode, 'price');
  if (!prices.length) return { value: null, currency: null };
  const best = [...prices].sort((a, b) => Number(b.attrs.date ?? 0) - Number(a.attrs.date ?? 0))[0];
  const p = parsePriceField(textOf(best));
  return { value: p.value, currency: best.attrs.currency ?? p.currency };
}

/** One XML <product> node -> Offer (the cheapest orderable offer, else the cheapest). */
export function xmlOffer(product, { now = Date.now(), feed = {} } = {}) {
  const offers = kids(kid(product, 'offers'), 'offer');
  const ean = textOf(find(product, 'ean'));
  const sku = textOf(find(product, 'sku'));
  const mpn = textOf(find(product, 'mpn'));
  const mapped = (offers.length ? offers : [product]).map((o) => {
    const { value, currency } = latestPrice(o);
    const stock = tdStock(textOf(kid(o, 'availability')) || textOf(kid(product, 'availability')), textOf(kid(o, 'inStock')) || textOf(kid(product, 'inStock')), now);
    const dt = textOf(kid(o, 'deliveryTime')) || textOf(kid(product, 'deliveryTime'));
    return {
      ids: { merchant: normId(o.attrs?.sourceProductId ?? sku), awin: null, ean: normGtin(ean), mpn: normId(mpn) },
      url: textOf(kid(o, 'sourceProductUrl')) || null,
      trackingUrl: textOf(kid(o, 'productUrl')) || null,
      title: cleanText(textOf(kid(product, 'name'))),
      brand: cleanText(textOf(kid(product, 'brand'))),
      imageUrl: cleanText(textOf(kid(product, 'productImage'))),
      price: value,
      currency: (currency ?? 'EUR').toUpperCase(),
      ...stock,
      deliveryEstimate: stock.deliveryEstimate ?? (stock.inStock ? deliveryFromText(dt, now) : null),
      condition: cleanText(textOf(kid(o, 'condition')))?.toLowerCase() ?? null,
      seller: cleanText(textOf(kid(o, 'programName'))) ?? feed.name ?? null,
      updatedAt: o.attrs?.modifiedDate ?? null,
    };
  });
  return pickBest(mapped);
}

/** One JSON product -> Offer. */
export function jsonOffer(product, { now = Date.now(), feed = {} } = {}) {
  const offers = [].concat(product.offers ?? []);
  const id = product.identifiers ?? {};
  const mapped = (offers.length ? offers : [product]).map((o) => {
    let { value, currency } = parsePriceField(o.price);
    if (value === null && Array.isArray(o.priceHistory) && o.priceHistory.length) {
      const last = [...o.priceHistory].sort((a, b) => Number(b.date ?? 0) - Number(a.date ?? 0))[0];
      const pv = last?.price;
      const p = typeof pv === 'object' && pv ? { value: parsePriceField(pv.value).value, currency: pv.currency ?? null } : parsePriceField(pv);
      value = p.value;
      currency = p.currency ?? last?.currency ?? currency;
    }
    const stock = tdStock(o.availability ?? product.availability, o.inStock ?? product.inStock, now);
    return {
      ids: { merchant: normId(o.sourceProductId ?? id.sku), awin: null, ean: normGtin(id.ean), mpn: normId(id.mpn) },
      url: cleanText(o.sourceProductUrl) ?? null,
      trackingUrl: cleanText(o.productUrl) ?? null,
      title: cleanText(product.name),
      brand: cleanText(product.brand),
      imageUrl: cleanText(typeof product.productImage === 'object' ? product.productImage?.url : product.productImage),
      price: value,
      currency: (currency ?? o.currency ?? 'EUR').toUpperCase(),
      ...stock,
      deliveryEstimate: stock.deliveryEstimate ?? (stock.inStock ? deliveryFromText(o.deliveryTime, now) : null),
      condition: cleanText(o.condition)?.toLowerCase() ?? null,
      seller: cleanText(o.programName) ?? feed.name ?? null,
      updatedAt: o.modified ?? null,
    };
  });
  return pickBest(mapped);
}

function pickBest(list) {
  return [...list].sort((a, b) => Number(b.inStock) - Number(a.inStock) || (a.price ?? Infinity) - (b.price ?? Infinity))[0] ?? null;
}

export const FORMATS = {
  'td-xml': { rows: xmlProducts, offer: xmlOffer },
  'td-json': { rows: jsonProducts, offer: jsonOffer },
};

// parseDeliveryDate is re-exported for tests that check "Available <date>" style delivery text.
export { parseDeliveryDate };
