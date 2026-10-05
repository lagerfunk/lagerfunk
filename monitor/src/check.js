// Shared shapes. Field names of Check, Alert and Watch item are a contract with the bot (../bot). Do not rename.

/**
 * @typedef {Object} Check
 * @property {string} id               `${retailer}:${productKey}:${checkedAt}`
 * @property {string} retailer         retailer id, e.g. "mediamarkt"
 * @property {string} productKey       e.g. "ps5-pro"
 * @property {string|null} title
 * @property {string} url              product page a buyer should open
 * @property {boolean|null} inStock    true = can be ordered now (includes orderable pre-orders and back-orders)
 * @property {number|null} price       EUR incl. VAT of the offer described by soldBy
 * @property {"EUR"} currency
 * @property {string|null} soldBy      seller of that offer, as shown by the shop
 * @property {string} checkedAt        ISO timestamp
 * @property {boolean} ok              false = fetch or parse failed, the other fields are not trustworthy
 * @property {number|null} httpStatus
 * @property {string|null} error       e.g. "blocked:akamai", "rate_limited", "not_found", "parse:no_offer"
 * Added 2026-10-04 (see INTERFACE_CHANGES.md):
 * @property {string|null} deliveryEstimate  earliest delivery date YYYY-MM-DD (Europe/Berlin) if known
 * @property {boolean} deliveryAssumed       true when deliveryEstimate is our default guess, not shown by the shop
 * @property {boolean} isPreorder            product not released yet
 * @property {boolean} isBackorder           orderable but not in stock (shop says so, or delivery more than 14 days out)
 * @property {boolean|null} soldByRetailer   true = the retailer itself or the official store, false = marketplace seller, null = unknown
 * @property {string|null} stockText         short shop wording, e.g. "Nur noch 2 auf Lager"
 * @property {string|null} imageUrl
 * @property {number} bytes                  decoded bytes read for this check
 * @property {boolean} viaProxy
 */

/**
 * @typedef {Object} Alert
 * @property {string} key       stable dedupe key
 * @property {"restock"|"price_drop"|"lowest_30d"|"ships_before"} kind
 * @property {string} productKey
 * @property {string} retailer
 * @property {string|null} title
 * @property {string} url
 * @property {number|null} price
 * @property {number|null} listPrice
 * @property {number|null} lowest30d      lowest in-stock price from our own history in the 30 days before this check
 * @property {string} detectedAt
 * Optional extras: previousPrice, deliveryEstimate, deliveryAssumed, shipsBy, isPreorder, isBackorder, inStock,
 * stockText, soldBy, historyDays, firstSeenAt, lowest30dSource ("own"), listPriceType, imageUrl
 */

/**
 * @typedef {Object} WatchItem
 * @property {string} productKey
 * @property {string} [retailer]      optional, detected from the URL host when missing
 * @property {string} url
 * @property {number|null} [threshold] alert only at or under this price; null = any price
 * @property {number|null} [listPrice]
 * @property {number} [intervalSec]
 * Optional extras: shipsBy (YYYY-MM-DD), sku, match, listPriceType ("uvp"), minDropPct, minDropEur, title
 */

export function makeCheck(base) {
  const checkedAt = base.checkedAt ?? new Date().toISOString();
  return {
    id: `${base.retailer}:${base.productKey}:${checkedAt}`,
    retailer: base.retailer,
    productKey: base.productKey,
    title: base.title ?? null,
    url: base.url,
    inStock: base.inStock ?? null,
    price: base.price ?? null,
    currency: 'EUR',
    soldBy: base.soldBy ?? null,
    checkedAt,
    ok: base.ok ?? false,
    httpStatus: base.httpStatus ?? null,
    error: base.error ?? null,
    deliveryEstimate: base.deliveryEstimate ?? null,
    deliveryAssumed: base.deliveryAssumed ?? false,
    isPreorder: base.isPreorder ?? false,
    isBackorder: base.isBackorder ?? false,
    soldByRetailer: base.soldByRetailer ?? null,
    stockText: base.stockText ?? null,
    imageUrl: base.imageUrl ?? null,
    bytes: base.bytes ?? 0,
    viaProxy: base.viaProxy ?? false,
  };
}

/**
 * Classify a page that did not parse into a product. Order matters: real pages of protected shops
 * still reference the vendor script, so only call this when parsing failed.
 */
export function classifyFailure(status, text = '') {
  const t = String(text).slice(0, 200000);
  if (status === 429) return 'rate_limited';
  if (/KPSDK|ips\.js\?KP_UIDz|x-kpsdk/i.test(t)) return 'blocked:kasada';
  if (/captcha-delivery\.com|geo\.captcha-delivery|datadome/i.test(t)) return 'blocked:datadome';
  if (/px-captcha|_pxAppId|perimeterx|px-cloud\.net/i.test(t)) return 'blocked:perimeterx';
  if (/validateCaptcha|opfcaptcha|Geben Sie die unten angezeigten Zeichen ein|Enter the characters you see below/i.test(t)) return 'blocked:amazon-captcha';
  if (/cf-chl-|cf_chl_opt|Just a moment\.\.\.|Attention Required! \| Cloudflare|challenges\.cloudflare\.com\/cdn-cgi/i.test(t) && t.length < 60000) return 'blocked:cloudflare';
  if (/Reference&#32;&#35;|Reference #\d|Access Denied[\s\S]{0,400}akamai|\b\d\.[0-9a-f]{8}\.\d{10}\.[0-9a-f]{6,8}\b|sec-if-cpt|\/akam\/13\//i.test(t) && t.length < 60000) return 'blocked:akamai';
  if (/queue-it\.net|queueit/i.test(t) && t.length < 60000) return 'queue_active';
  if (status === 404 || status === 410) return 'not_found';
  if (status === 403) return 'blocked:403';
  if (status >= 500) return `http_${status}`;
  if (status >= 400) return `http_${status}`;
  return null;
}

export const isBlockError = (e) => typeof e === 'string' && (e.startsWith('blocked') || e === 'rate_limited' || /^http_5\d\d$/.test(e));
