// Small runtime-neutral helpers. No Node APIs here: this file runs in Node 22 and Cloudflare Workers.

export const DAY_MS = 86400000;

/** Parse a price written the German way ("1.364,00 €"), the English way ("€2,099.00") or as a number. */
export function parseEuro(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return Number.isFinite(input) ? round2(input) : null;
  let s = String(input).replace(/&nbsp;| | /g, ' ').replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    s = decimals === 3 && s.indexOf(',') === lastComma ? s.replace(',', '') : s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot >= 0) {
    const decimals = s.length - lastDot - 1;
    // "1.305" (German thousands, no cents) vs "899.99"
    if (decimals === 3 && s.indexOf('.') === lastDot) s = s.replace('.', '');
    else if (s.indexOf('.') !== lastDot) s = s.replace(/\.(?=.*\.)/g, '');
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? round2(n) : null;
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Calendar date (YYYY-MM-DD) in Europe/Berlin for a Date or timestamp. */
export function berlinDate(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return new Date(date.getTime() + 2 * 3600000).toISOString().slice(0, 10);
  }
}

export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayDiff(fromIsoDay, toIsoDay) {
  return Math.round((Date.parse(toIsoDay + 'T00:00:00Z') - Date.parse(fromIsoDay + 'T00:00:00Z')) / DAY_MS);
}

/** Add business days (Mon to Fri) to a date, return the Berlin calendar date. Conservative on purpose. */
export function addBusinessDays(from, n) {
  const d = new Date(from instanceof Date ? from.getTime() : from);
  let left = Math.max(0, Math.round(n));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return berlinDate(d);
}

const MONTHS = {
  jan: 1, januar: 1, feb: 2, februar: 2, 'mär': 3, maerz: 3, 'märz': 3, mrz: 3, apr: 4, april: 4, mai: 5,
  jun: 6, juni: 6, jul: 7, juli: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, okt: 10, oktober: 10,
  nov: 11, november: 11, dez: 12, dezember: 12,
  january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, october: 10, december: 12,
};
const MONTH_RE = new RegExp(`\\b(${Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')})\\.?(?:\\s+(\\d{4}))?`, 'i');

/**
 * Earliest delivery date in a German delivery text, as YYYY-MM-DD.
 * Handles "Donnerstag, 8. Oktober", "14. - 15. Oktober", "8. Oktober - 3. November", "2. März 2027",
 * "08.10.2026", "2026-10-08T22:00:00Z", "morgen", "heute".
 */
export function parseDeliveryDate(text, now = Date.now()) {
  if (!text) return null;
  const s = String(text).replace(/ /g, ' ');
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})(T[\d:.]+Z?)?/);
  if (iso) return iso[4] ? berlinDate(new Date(iso[0])) : `${iso[1]}-${iso[2]}-${iso[3]}`;
  const num = s.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/);
  if (num) {
    const y = num[3].length === 2 ? 2000 + Number(num[3]) : Number(num[3]);
    return fmt(y, Number(num[2]), Number(num[1]));
  }
  if (/\bheute\b|\btoday\b/i.test(s)) return berlinDate(now);
  if (/\bübermorgen\b/i.test(s)) return berlinDate(now + 2 * DAY_MS);
  if (/\bmorgen\b|\btomorrow\b/i.test(s)) return berlinDate(now + DAY_MS);
  const dayRe = /(\d{1,2})\.(?!\d)/g;
  let m;
  while ((m = dayRe.exec(s))) {
    const rest = s.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const mm = rest.match(MONTH_RE);
    if (!mm) continue;
    const month = MONTHS[mm[1].toLowerCase()];
    const day = Number(m[1]);
    if (!month || day < 1 || day > 31) continue;
    let year = mm[2] ? Number(mm[2]) : null;
    if (!year) {
      // the year may sit after a range end, e.g. "8. Oktober - 3. November 2026"
      const y = s.slice(m.index).match(/\b(20\d{2})\b/);
      year = y ? Number(y[1]) : inferYear(month, day, now);
    }
    return fmt(year, month, day);
  }
  return null;
}

function inferYear(month, day, now) {
  const today = new Date(now);
  const y = today.getUTCFullYear();
  const candidate = Date.UTC(y, month - 1, day);
  return candidate < now - 45 * DAY_MS ? y + 1 : y;
}

function fmt(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

export function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanText(s) {
  return s === null || s === undefined ? null : decodeEntities(String(s)).replace(/\s+/g, ' ').trim() || null;
}

/** All JSON-LD blocks in a page, flattened (arrays, @graph, BuyAction.object). */
export function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      try {
        data = JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' '));
      } catch {
        continue;
      }
    }
    flattenLd(data, out);
  }
  return out;
}

function flattenLd(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) flattenLd(n, out);
    return;
  }
  out.push(node);
  if (node['@graph']) flattenLd(node['@graph'], out);
  if (node.object && typeof node.object === 'object') flattenLd(node.object, out);
  if (Array.isArray(node.hasVariant)) flattenLd(node.hasVariant, out);
}

const typeOf = (n) => [].concat(n?.['@type'] ?? []).map((t) => String(t).toLowerCase());

/** The product node with offers, and its best offer (in stock and cheapest first). */
export function productFromJsonLd(nodes) {
  const products = nodes.filter((n) => n.offers && typeOf(n).some((t) => t === 'product' || t === 'productgroup' || t === 'individualproduct' || t === 'productmodel'));
  if (!products.length) return null;
  const product = products[0];
  const offers = [].concat(product.offers).flatMap((o) => (typeOf(o).includes('aggregateoffer') && o.offers ? [].concat(o.offers) : [o]));
  const scored = offers
    .map((o) => ({ o, price: parseEuro(o.price ?? o.lowPrice ?? o.priceSpecification?.price), avail: availabilityOf(o.availability) }))
    .sort((a, b) => Number(b.avail.inStock) - Number(a.avail.inStock) || (a.price ?? Infinity) - (b.price ?? Infinity));
  const best = scored[0];
  if (!best) return null;
  return { product, offer: best.o, price: best.price, ...best.avail };
}

/** Map schema.org availability to our flags. */
export function availabilityOf(value) {
  const v = String(value ?? '').toLowerCase().replace(/^https?:\/\/schema\.org\//, '');
  const inStock = ['instock', 'limitedavailability', 'instoreonly', 'onlineonly', 'preorder', 'presale', 'backorder'].includes(v);
  return { inStock, isPreorder: v === 'preorder' || v === 'presale', isBackorder: v === 'backorder', availability: v || null };
}

export function sellerName(offer) {
  const s = offer?.seller ?? offer?.offeredBy;
  if (!s) return null;
  if (typeof s === 'string') return cleanText(s);
  return cleanText(s.name ?? s.legalName ?? null);
}

/** Earliest delivery date from schema.org shippingDetails (handling + transit, business days). */
export function deliveryFromShipping(offer, now) {
  const details = [].concat(offer?.shippingDetails ?? []);
  let best = null;
  for (const d of details) {
    const t = d?.deliveryTime;
    if (!t) continue;
    const handling = Number(t.handlingTime?.minValue ?? t.handlingTime?.value ?? 0);
    const transit = Number(t.transitTime?.minValue ?? t.transitTime?.value ?? NaN);
    if (!Number.isFinite(transit)) continue;
    const date = addBusinessDays(now, handling + transit);
    if (!best || date < best) best = date;
  }
  return best;
}

export function firstMatch(text, re, group = 1) {
  const m = re.exec(text);
  return m ? m[group] : null;
}

/** FNV-1a 32 bit, for stable per-item phase offsets. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Stop-reading predicate: the first JSON-LD block that carries "offers" is complete. */
export function untilJsonLdOffers(text) {
  let from = 0;
  for (;;) {
    const i = text.indexOf('application/ld+json', from);
    if (i < 0) return false;
    const end = text.indexOf('</script>', i);
    if (end < 0) return false;
    if (text.slice(i, end).includes('"offers"')) return true;
    from = end;
  }
}
