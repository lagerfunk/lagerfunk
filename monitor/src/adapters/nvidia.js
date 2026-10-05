// Nvidia Founders Edition, Germany. The marketplace page calls api.nvidia.partners/edge/product/search, which
// returns every FE card listed for the locale with prdStatus, stock and price in ~6 KB of JSON.
// The older api.store.nvidia.com/partner/v1/feinventory endpoint answered {"listMap":[]} for all DE codes on 2026-10-04.
// The DE code is PROFESHOP5090: the "PRO" prefix points to Proshop as the fulfilment partner (inference, not confirmed).
import { JSON_HEADERS } from './common.js';
import { parseEuro, cleanText } from '../util.js';

export const NVIDIA_SEARCH_DE =
  'https://api.nvidia.partners/edge/product/search?page=1&limit=12&locale=de-de&manufacturer=NVIDIA&manufacturer_filter=NVIDIA~1&category=GPU';

function wanted(item) {
  if (item.sku) return { sku: String(item.sku).toUpperCase() };
  if (item.match) return { text: String(item.match).toLowerCase() };
  const digits = String(item.productKey).match(/\d{4}(?:\s?ti)?/i);
  return digits ? { text: digits[0].toLowerCase() } : {};
}

export default {
  id: 'nvidia',
  name: 'NVIDIA Store',
  hosts: ['marketplace.nvidia.com', 'store.nvidia.com', 'api.nvidia.partners', 'nvidia.com'],
  officialSeller: /nvidia|proshop/i,
  trustUnknownSeller: true,
  defaultIntervalSec: 60,
  proxy: 'fallback',

  request(item) {
    const url = /api\.nvidia\.partners/.test(item.url) ? item.url : NVIDIA_SEARCH_DE;
    return { url, headers: { ...JSON_HEADERS, origin: 'https://marketplace.nvidia.com', referer: 'https://marketplace.nvidia.com/' } };
  },

  parse(text, ctx) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, error: 'parse:not_json' };
    }
    const list = [data?.searchedProducts?.featuredProduct, ...(data?.searchedProducts?.productDetails ?? [])].filter(Boolean);
    const w = wanted(ctx.item);
    const p = list.find((x) =>
      w.sku
        ? String(x.productSKU).toUpperCase() === w.sku || String(x.productUPC).toUpperCase().startsWith(w.sku)
        : w.text
          ? `${x.gpu} ${x.displayName} ${x.productTitle}`.toLowerCase().includes(w.text)
          : list.length === 1,
    );
    if (!p) return { ok: true, inStock: false, price: null, title: null, stockText: 'nicht gelistet', soldBy: 'NVIDIA', soldByRetailer: true };
    const r = p.retailers?.[0] ?? {};
    const status = String(p.prdStatus ?? '').toLowerCase();
    const inStock = p.productAvailable === true || status === 'buy_now' || status === 'in_stock' || Number(r.stock) > 0;
    return {
      ok: true,
      title: cleanText(p.productTitle ?? p.displayName),
      price: parseEuro(r.salePrice ?? p.mrp) ?? parseEuro(p.productPrice),
      inStock,
      isPreorder: false,
      isBackorder: false,
      soldBy: 'NVIDIA',
      soldByRetailer: true,
      stockText: p.prdStatus ?? null,
      imageUrl: p.imageURL ?? null,
      url: r.directPurchaseLink || p.internalLink || null,
    };
  },
};
