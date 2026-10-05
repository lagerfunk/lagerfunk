import {
  extractJsonLd, productFromJsonLd, sellerName, deliveryFromShipping, cleanText, firstMatch, decodeEntities, parseEuro,
  availabilityOf, untilJsonLdOffers, parseDeliveryDate,
} from '../util.js';

export const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'de-DE,de;q=0.9,en;q=0.6',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'upgrade-insecure-requests': '1',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
};

export const JSON_HEADERS = {
  'user-agent': BROWSER_HEADERS['user-agent'],
  accept: 'application/json, text/plain, */*',
  'accept-language': 'de-DE,de;q=0.9',
};

/**
 * Parse a product page through JSON-LD, with microdata and Open Graph fallbacks.
 * Returns Check fields, or { ok: false, error } when the page carries no offer.
 */
export function parseStructured(text, ctx, opts = {}) {
  const nodes = extractJsonLd(text);
  const hit = productFromJsonLd(nodes);
  if (hit) {
    const { product, offer, price } = hit;
    const seller = sellerName(offer) ?? sellerName(product);
    return {
      ok: true,
      title: cleanText(product.name),
      price,
      inStock: hit.inStock,
      isPreorder: hit.isPreorder,
      isBackorder: hit.isBackorder,
      stockText: hit.availability,
      soldBy: seller,
      deliveryEstimate: hit.inStock ? (deliveryFromDescription(product.description, ctx.now) ?? deliveryFromShipping(offer, ctx.now)) : null,
      imageUrl: firstImage(product.image),
      sku: product.sku ?? null,
    };
  }
  // Microdata (itemprop) fallback
  const mdPrice = firstMatch(text, /itemprop=["']price["'][^>]*content=["']([^"']+)["']/i) ?? firstMatch(text, /content=["']([^"']+)["'][^>]*itemprop=["']price["']/i);
  const mdAvail = firstMatch(text, /itemprop=["']availability["'][^>]*(?:content|href)=["']([^"']+)["']/i);
  const ogPrice = firstMatch(text, /property=["'](?:product|og):price:amount["'][^>]*content=["']([^"']+)["']/i);
  const ogAvail = firstMatch(text, /property=["'](?:product|og):availability["'][^>]*content=["']([^"']+)["']/i);
  const price = parseEuro(mdPrice ?? ogPrice);
  if (price !== null && (mdAvail || ogAvail || opts.allowPriceOnly)) {
    const av = availabilityOf(mdAvail ?? ogAvail);
    return {
      ok: true,
      title: cleanText(firstMatch(text, /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ?? firstMatch(text, /<title>([^<]+)<\/title>/i)),
      price,
      inStock: mdAvail || ogAvail ? av.inStock || /in ?stock|instock|lagernd/i.test(ogAvail ?? '') : null,
      isPreorder: av.isPreorder,
      isBackorder: av.isBackorder,
      stockText: av.availability,
      soldBy: null,
    };
  }
  return { ok: false, error: 'parse:no_offer' };
}

/** "Lieferung erfolgt am 12.11.2026" style promises, common on pre-order pages. */
export function deliveryFromDescription(desc, now) {
  const m = String(desc ?? '').match(/(?:Lieferung|Auslieferung|Versand|lieferbar)\s+(?:erfolgt\s+)?(?:voraussichtlich\s+)?(?:am|ab)\s+(\d{1,2}\.\d{1,2}\.\d{4})/i);
  return m ? parseDeliveryDate(m[1], now) : null;
}

function firstImage(img) {
  if (!img) return null;
  const v = Array.isArray(img) ? img[0] : img;
  return typeof v === 'string' ? v : v?.url ?? null;
}

export function titleFromHtml(text) {
  const t = firstMatch(text, /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ?? firstMatch(text, /<title>([^<]+)<\/title>/i);
  return t ? decodeEntities(t).replace(/\s+/g, ' ').trim() : null;
}

/**
 * Build a plain JSON-LD shop adapter. Most German shops publish schema.org offers server side,
 * so one adapter shape covers them; shops differ in seller rules and how far into the page we must read.
 */
export function jsonLdShop({ id, name, hosts, officialSeller, trustUnknownSeller = true, defaultIntervalSec = 60, proxy = 'fallback', earlyStop = true, extra }) {
  return {
    id,
    name,
    hosts,
    officialSeller,
    trustUnknownSeller,
    defaultIntervalSec,
    proxy,
    request(item) {
      return { url: item.url, headers: BROWSER_HEADERS, stopWhen: earlyStop ? untilJsonLdOffers : null };
    },
    parse(text, ctx) {
      const r = parseStructured(text, ctx);
      if (extra) Object.assign(r, extra(text, ctx, r) ?? {});
      if (r.ok && r.soldByRetailer === undefined) {
        if (r.soldBy && officialSeller) r.soldByRetailer = officialSeller.test(r.soldBy);
        else if (!r.soldBy && trustUnknownSeller) {
          r.soldBy = name;
          r.soldByRetailer = true;
        } else r.soldByRetailer = null;
      }
      return r;
    },
  };
}
