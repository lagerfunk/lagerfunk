// Shared helpers for feed formats: prices, delivery text, URL keys, identifier normalisation.
import { parseEuro, parseDeliveryDate, addBusinessDays, hostOf, cleanText } from '../util.js';

/** "1299.00", "1299,00", "1.299,00", 1299 or "15.00 EUR" -> { value, currency } (currency null when absent). */
export function parsePriceField(input) {
  if (input === null || input === undefined || input === '') return { value: null, currency: null };
  if (typeof input === 'number') return { value: Number.isFinite(input) ? Math.round(input * 100) / 100 : null, currency: null };
  const s = String(input).trim();
  const cur = /\b([A-Z]{3})\b/.exec(s)?.[1] ?? null;
  const num = s.replace(/[A-Za-z€$£\s]/g, '');
  if (/^-?\d+(\.\d+)?$/.test(num)) return { value: Math.round(Number(num) * 100) / 100, currency: cur };
  return { value: parseEuro(num), currency: cur };
}

const UNIT = /(werktag|arbeitstag|working|business|tag|day|woche|week|monat|month|stunde|hour)/i;

/** Earliest delivery date (YYYY-MM-DD, Europe/Berlin) from free text like "1-3 Werktage", "3 weeks", "sofort lieferbar", "12.11.2026". */
export function deliveryFromText(text, now = Date.now()) {
  const s = cleanText(text);
  if (!s) return null;
  const date = parseDeliveryDate(s, now);
  if (date) return date;
  if (/sofort|ab lager|lagernd|auf lager|same day|ready to ship|versandfertig/i.test(s) && !/\d/.test(s)) return addBusinessDays(now, 1);
  const range = new RegExp(`(\\d+)\\s*(?:(?:-|bis|to|und)\\s*(\\d+))?\\s*(?:[a-zA-Z.]{0,12}\\s*)?${UNIT.source}`, 'i').exec(s);
  if (!range) return null;
  const min = Number(range[1]);
  const unit = range[3].toLowerCase();
  if (/stunde|hour/.test(unit)) return addBusinessDays(now, 1);
  if (/woche|week/.test(unit)) return addBusinessDays(now, min * 5);
  if (/monat|month/.test(unit)) return addBusinessDays(now, min * 21);
  return addBusinessDays(now, min); // "Tage" and "days" are counted as business days, the conservative reading
}

const TRACKING_PARAMS = /^(utm_.*|gclid|fbclid|msclkid|awc|ref|sref|spartner|wmc|campaign|cmpid|cid|source|aff.*|partner.*|tduid|clickid)$/i;

/** host + path + non-tracking query, lower-case, no www, no trailing slash. Used to match watch URLs against feed URLs. */
export function canonUrl(url) {
  try {
    const u = new URL(url);
    let path = decodeURIComponent(u.pathname).toLowerCase().replace(/\/+$/, '');
    if (path === '') path = '/';
    const q = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).map(([k, v]) => `${k.toLowerCase()}=${v}`).sort().join('&');
    return `${hostOf(url)}${path}${q ? `?${q}` : ''}`;
  } catch {
    return null;
  }
}

// Product id inside a shop URL, per host. Strict on purpose: a loose "any long number" rule would match memory sizes
// (32768 MB) and cross-link different graphics cards.
const ID_PATTERNS = [
  ['galaxus.de', /-(\d{5,})(?:[/?#]|$)/],
  ['proshop.de', /\/(\d{5,})(?:[/?#]|$)/],
  ['computeruniverse.net', /\/p\/([a-z0-9]+(?:-[a-z0-9]+)?)(?:[/?#]|$)/i],
  ['cyberport.de', /\/pdp\/([a-z0-9-]+)\//i],
  ['caseking.de', /\/([a-z]{2,6}-\d+)\.html/i],
  ['alternate.de', /\/product\/(\d+)(?:[/?#]|$)/],
  ['mediamarkt.de', /-(\d{6,})\.html/],
  ['saturn.de', /-(\d{6,})\.html/],
  ['mueller.de', /-(ipn\d+)\/?(?:[?#]|$)/i],
];

export function productIdFromUrl(url) {
  const host = hostOf(url);
  const hit = ID_PATTERNS.find(([h]) => host === h || host.endsWith(`.${h}`));
  if (!hit) return null;
  const m = hit[1].exec(url);
  return m ? m[1].toLowerCase() : null;
}

/** Identifier normalised for equality: digits-only for GTIN/EAN (leading zeros stripped), lower-case trimmed otherwise. */
export const normId = (v) => {
  const s = cleanText(v);
  return s ? s.toLowerCase() : null;
};
export const normGtin = (v) => {
  const s = (cleanText(v) ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return s.length >= 8 ? s : null;
};

export const truthy = (v) => /^(1|true|yes|ja|y)$/i.test(String(v ?? '').trim());
export const falsy = (v) => /^(0|false|no|nein|n)$/i.test(String(v ?? '').trim());

export const NEG_STOCK = /out[ _-]?of[ _-]?stock|nicht (?:auf lager|lieferbar|verf)|ausverkauft|sold[ _-]?out|not available|unavailable|derzeit nicht|vergriffen|discontinued|auslaufartikel|nicht mehr lieferbar/i;
export const PRE_STOCK = /pre[ _-]?order|vorbestell|vorbesteller|erscheint am|release/i;
export const BACK_STOCK = /back[ _-]?order|nachbestell|lieferr(?:[uü]|ue)ckstand|auf anfrage/i;
export const POS_STOCK = /^(?:in[ _-]?stock|available|auf lager|lagernd|verf(?:[uü]|ue)gbar|lieferbar|sofort|limited|ready)/i;

/** Tracking links often carry the shop URL in a query parameter (ued, url, murl). Returns it decoded, or null. */
export function targetOfTracking(url) {
  try {
    const u = new URL(url);
    for (const k of ['ued', 'url', 'murl', 'u']) {
      const v = u.searchParams.get(k);
      if (v && /^https?:\/\//i.test(v)) return v;
    }
  } catch {
    /* not a URL */
  }
  return null;
}
