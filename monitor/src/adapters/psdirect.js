// PlayStation Direct (Sony's own store). The page is heavy; the SAP Commerce product API the page itself calls
// answers with ~5 KB of JSON including stockLevelStatus. No login needed for reading stock.
import { JSON_HEADERS, BROWSER_HEADERS } from './common.js';
import { cleanText, firstMatch } from '../util.js';

// Known product codes so the first check needs no page fetch.
const KNOWN_SKUS = {
  'de-de/buy-consoles/playstation5-pro-console-2-tb': '1000050720-DE',
  'de-de/buy-consoles/playstation5-pro-console': '1000050720-DE',
};

function locale(url) {
  const m = String(url).match(/playstation\.com\/([a-z]{2})-([a-z]{2})\//i);
  return m ? { lang: m[1].toLowerCase(), country: m[2].toLowerCase() } : { lang: 'de', country: 'de' };
}

function skuFor(item) {
  if (item.sku) return item.sku;
  const fromQuery = firstMatch(item.url, /[?&](?:sku|productCodes)=([A-Z0-9-]+)/i);
  if (fromQuery) return fromQuery;
  const path = String(item.url).replace(/^https?:\/\/[^/]+\//, '').replace(/[?#].*$/, '').replace(/\/$/, '');
  return KNOWN_SKUS[path] ?? null;
}

export default {
  id: 'psdirect',
  name: 'PlayStation Direct',
  hosts: ['direct.playstation.com', 'api.direct.playstation.com'],
  officialSeller: /playstation|sony/i,
  trustUnknownSeller: true,
  defaultIntervalSec: 60,
  proxy: 'fallback',

  /** Resolve the product code once from the page if it is not configured. */
  async prepare(item, ctx) {
    if (skuFor(item) || item._sku) return;
    const res = await ctx.fetchText({ url: item.url, headers: BROWSER_HEADERS, stopWhen: (t) => t.includes('itemprop="sku"') && t.includes('itemprop="price"') });
    const sku = firstMatch(res.text, /itemprop="sku"\s+content="([^"]+)"/);
    if (sku) item._sku = sku;
  },

  request(item) {
    const sku = skuFor(item) ?? item._sku;
    if (!sku) return { url: item.url, headers: BROWSER_HEADERS };
    const { lang, country } = locale(item.url);
    const url = `https://api.direct.playstation.com/commercewebservices/ps-direct-${country}/users/anonymous/products/productList?fields=BASIC&lang=${lang}_${country.toUpperCase()}&productCodes=${encodeURIComponent(sku)}`;
    return { url, headers: { ...JSON_HEADERS, origin: 'https://direct.playstation.com', referer: item.url } };
  },

  parse(text, ctx) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Page fallback: price from microdata, stock unknown.
      const price = firstMatch(text, /itemprop="price"\s+content="([\d.]+)"/);
      if (!price) return { ok: false, error: 'parse:no_offer' };
      return { ok: true, price: Number(price), inStock: null, title: cleanText(firstMatch(text, /itemprop="name"\s+content="([^"]+)"/)), soldBy: 'PlayStation Direct', soldByRetailer: true, stockText: 'stock unknown: product code missing' };
    }
    const p = data?.products?.[0];
    if (!p || p.validProductCode === false) return { ok: false, error: 'not_found' };
    const status = p.stock?.stockLevelStatus ?? null;
    const orderable = p.purchasable !== false && (status === 'inStock' || status === 'lowStock');
    return {
      ok: true,
      title: cleanText(p.name),
      price: typeof p.price?.value === 'number' ? p.price.value : null,
      inStock: orderable,
      isPreorder: p.preOrderProduct === true,
      isBackorder: false,
      soldBy: 'PlayStation Direct',
      soldByRetailer: true,
      stockText: [status, p.loginGated ? 'Login noetig' : null].filter(Boolean).join(', '),
    };
  },
};
