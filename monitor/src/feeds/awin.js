// Awin product feeds, two formats.
//
// 1. Classic CSV from Create-a-Feed (still the format for existing advertisers; Awin kept it when it introduced
//    Google-format feeds on 2026-04-02). URL shape, as produced by Create-a-Feed:
//      https://productdata.awin.com/datafeed/download/apikey/<KEY>/language/de/fid/<FID>/columns/<LIST>/format/csv/delimiter/%2C/compression/gzip/adultcontent/1/
//    Column names used here: aw_deep_link (tracked), merchant_deep_link (untracked), product_name, aw_product_id,
//    merchant_product_id, search_price, currency, in_stock ("1", "0", blank = no stock; any other text = stock),
//    stock_status, stock_quantity, pre_order, is_for_sale, valid_from, valid_to, delivery_time, ean, product_gtin, mpn,
//    brand_name, merchant_image_url, merchant_name, last_updated. Only the columns picked in Create-a-Feed arrive.
//
// 2. Enhanced (Google format) JSON Lines, for advertisers that upgraded:
//      GET https://api.awin.com/publishers/<PUBLISHER_ID>/awinfeeds/download/<ADVERTISER_ID>-retail-de_DE.jsonl
//      Authorization: Bearer <API token>      (max 5 requests per minute, never two at once for one advertiser)
//    One JSON object per line. The LAST line is an error object when the download is incomplete.
import { csvRecords } from './csv.js';
import { parsePriceField, deliveryFromText, truthy, falsy, normId, normGtin, NEG_STOCK, PRE_STOCK, BACK_STOCK, POS_STOCK } from './common.js';
import { cleanText, addBusinessDays } from '../util.js';

/** Build a classic feed URL (documented parameters). Create-a-Feed gives the same string; this is for scripts. */
export function awinFeedUrl({ apiKey, fid, language = 'de', columns = DEFAULT_COLUMNS, delimiter = '%2C' }) {
  return `https://productdata.awin.com/datafeed/download/apikey/${apiKey}/language/${language}/fid/${fid}/columns/${columns.join(',')}/format/csv/delimiter/${delimiter}/compression/gzip/adultcontent/1/`;
}

export const DEFAULT_COLUMNS = [
  'aw_deep_link', 'product_name', 'aw_product_id', 'merchant_product_id', 'merchant_image_url', 'description', 'merchant_category',
  'search_price', 'merchant_name', 'merchant_id', 'currency', 'merchant_deep_link', 'last_updated', 'brand_name', 'ean', 'product_gtin', 'mpn',
  'in_stock', 'stock_status', 'stock_quantity', 'pre_order', 'is_for_sale', 'valid_from', 'valid_to', 'delivery_time', 'condition',
];

const REQUIRED_CLASSIC = ['search_price'];

export async function* classicRows(chunks, { delimiter = null } = {}) {
  yield* csvRecords(chunks, {
    delimiter,
    onHeader(h) {
      for (const c of REQUIRED_CLASSIC) if (!h.includes(c)) throw new Error(`feed:missing_column:${c}`);
      if (!h.includes('merchant_deep_link') && !h.includes('aw_deep_link')) throw new Error('feed:missing_column:merchant_deep_link');
    },
  });
}

function validWindow(row, now) {
  const from = Date.parse(row.valid_from ?? '');
  const to = Date.parse(row.valid_to ?? '');
  if (Number.isFinite(from) && from > now) return false;
  if (Number.isFinite(to) && to < now) return false;
  return true;
}

/** Stock reading of one classic row. Negative signals win, so doubt never produces a restock alert. */
export function classicStock(row, now) {
  const text = cleanText(row.stock_status)?.toLowerCase() ?? '';
  const qty = Number(String(row.stock_quantity ?? '').replace(/[^\d.-]/g, ''));
  const hasQty = String(row.stock_quantity ?? '').trim() !== '' && Number.isFinite(qty);
  const flag = String(row.in_stock ?? '').trim();
  const out = { inStock: false, isPreorder: false, isBackorder: false, stockText: text || null };
  if (falsy(row.is_for_sale) && String(row.is_for_sale).trim() !== '') return out;
  if (!validWindow(row, now)) return { ...out, stockText: text || 'Angebot nicht gueltig' };
  if (PRE_STOCK.test(text)) return { ...out, inStock: true, isPreorder: true };
  if (BACK_STOCK.test(text)) return { ...out, inStock: true, isBackorder: true };
  if (NEG_STOCK.test(text)) return out;
  if (flag !== '' && falsy(flag)) return out;
  if (hasQty && qty <= 0) return out;
  if (flag !== '') return { ...out, inStock: true }; // "1", or any other text, means stock (Awin rule)
  if (hasQty && qty > 0) return { ...out, inStock: true };
  if (POS_STOCK.test(text)) return { ...out, inStock: true };
  return out; // blank everywhere: Awin reads that as "no stock"
}

/** One classic CSV row -> normalised Offer. */
export function classicOffer(row, { now = Date.now(), feed = {} } = {}) {
  const { value: price, currency } = parsePriceField(row.search_price ?? row.price);
  const stock = classicStock(row, now);
  return {
    ids: {
      merchant: normId(row.merchant_product_id),
      awin: normId(row.aw_product_id),
      ean: normGtin(row.ean) ?? normGtin(row.product_gtin) ?? normGtin(row.upc),
      mpn: normId(row.mpn),
    },
    url: cleanText(row.merchant_deep_link) ?? null,
    trackingUrl: cleanText(row.aw_deep_link) ?? null,
    title: cleanText(row.product_name),
    brand: cleanText(row.brand_name),
    imageUrl: cleanText(row.merchant_image_url) ?? cleanText(row.aw_image_url),
    price,
    currency: (currency ?? cleanText(row.currency) ?? 'EUR').toUpperCase(),
    ...stock,
    deliveryEstimate: stock.inStock ? deliveryFromText(row.delivery_time, now) : null,
    condition: cleanText(row.condition)?.toLowerCase() ?? null,
    seller: cleanText(row.merchant_name) ?? feed.name ?? null,
    updatedAt: cleanText(row.last_updated),
  };
}

// ---------- enhanced JSON Lines ----------

/** Async generator of parsed JSON objects, one per line. Throws feed:incomplete when the last line is an error object. */
export async function* jsonlRows(chunks) {
  let buf = '';
  let last = null;
  const parse = (line) => {
    const t = line.trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      throw new Error('feed:bad_json_line');
    }
  };
  // Every product line has product_details. A last line without it is Awin's error object: the download is incomplete.
  const isError = (o) => !o || typeof o !== 'object' || !o.product_details;
  for await (const chunk of chunks) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const obj = parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (obj === null) continue;
      if (last) yield last;
      last = obj;
    }
  }
  const tail = parse(buf);
  if (tail !== null) {
    if (last) yield last;
    last = tail;
  }
  if (last) {
    if (isError(last)) throw new Error('feed:incomplete');
    yield last;
  }
}

function parseRange(s) {
  const [a, b] = String(s ?? '').split('/');
  const fix = (x) => Date.parse(String(x ?? '').trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return [fix(a), fix(b)];
}

/**
 * Awin documents the groups product_basic and price_and_availability in its example record; identifiers, detailed
 * description and delivery are documented as sections. Read every field from the flattened groups so a different
 * grouping of those sections does not matter. Only the direct children of product_details are flattened.
 */
function flatten(d) {
  const flat = {};
  for (const [k, v] of Object.entries(d ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(flat, v);
    else flat[k] = v;
  }
  return flat;
}

/** One enhanced JSONL record -> normalised Offer. */
export function enhancedOffer(rec, { now = Date.now(), feed = {} } = {}) {
  const f = flatten(rec.product_details ?? rec);
  let { value: price, currency } = parsePriceField(f.price);
  if (f.sale_price) {
    const sale = parsePriceField(f.sale_price);
    const [from, to] = f.sale_price_effective_date ? parseRange(f.sale_price_effective_date) : [NaN, NaN];
    const live = (!Number.isFinite(from) || from <= now) && (!Number.isFinite(to) || to >= now);
    if (sale.value !== null && live) {
      price = sale.value;
      currency = sale.currency ?? currency;
    }
  }
  const avail = String(f.availability ?? '').toLowerCase();
  const expired = f.expiration_date && Date.parse(f.expiration_date) < now;
  const inStock = !expired && (avail === 'in_stock' || avail === 'preorder' || avail === 'backorder');
  let deliveryEstimate = null;
  if (inStock) {
    if ((avail === 'preorder' || avail === 'backorder') && f.availability_date) deliveryEstimate = String(f.availability_date).slice(0, 10);
    else {
      const ships = [].concat(f.shipping ?? []).filter((s) => s && (!s.country || String(s.country).toUpperCase() === 'DE'));
      let best = null;
      for (const s of ships) {
        const days = Number(s.min_handling_time ?? f.min_handling_time ?? 0) + Number(s.min_transit_time ?? NaN);
        if (Number.isFinite(days) && (best === null || days < best)) best = days;
      }
      if (best !== null) deliveryEstimate = addBusinessDays(now, best);
    }
  }
  return {
    ids: { merchant: normId(f.id), awin: null, ean: normGtin(f.gtin), mpn: normId(f.mpn) },
    url: cleanText(f.link) ?? null,
    trackingUrl: cleanText(f.aw_deep_link) ?? null,
    title: cleanText(f.title),
    brand: cleanText(f.brand),
    imageUrl: cleanText(f.image_link),
    price,
    currency: (currency ?? 'EUR').toUpperCase(),
    inStock,
    isPreorder: avail === 'preorder',
    isBackorder: avail === 'backorder',
    stockText: avail || null,
    deliveryEstimate,
    condition: cleanText(f.condition)?.toLowerCase() ?? null,
    seller: rec.meta?.advertiser_name ?? feed.name ?? null,
    updatedAt: null,
  };
}

export const FORMATS = {
  'awin-csv': { rows: classicRows, offer: classicOffer },
  'awin-jsonl': { rows: jsonlRows, offer: enhancedOffer },
};
