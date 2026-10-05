// Shops that publish schema.org offers in the HTML. One builder, per-shop seller rules and quirks.
import { jsonLdShop, parseStructured, BROWSER_HEADERS } from './common.js';
import { firstMatch, parseDeliveryDate, cleanText, stripTags, hostOf } from '../util.js';

// OTTO: JSON-LD has price, availability and shipping times but no seller, and OTTO mixes in marketplace partners.
// Protection: Kasada (plain HTTP gets a KPSDK challenge page). Unknown seller is NOT trusted for alerts.
export const otto = jsonLdShop({
  id: 'otto', name: 'OTTO', hosts: ['otto.de'], officialSeller: /^otto\b/i, trustUnknownSeller: false, proxy: 'always',
});

// Mueller: JSON-LD offers include seller "Müller Handels GmbH & Co. KG". No bot wall seen with plain HTTP.
export const mueller = jsonLdShop({
  id: 'mueller', name: 'Müller', hosts: ['mueller.de'], officialSeller: /m(ü|ue)ller/i, trustUnknownSeller: true, proxy: 'fallback',
});

// notebooksbilliger: JSON-LD offers with seller "Notebooksbilliger". Akamai Bot Manager: plain HTTP got an
// Akamai error page ("uups..." with a reference id), a stealth browser got the real page.
export const notebooksbilliger = jsonLdShop({
  id: 'notebooksbilliger', name: 'notebooksbilliger', hosts: ['notebooksbilliger.de'], officialSeller: /notebooksbilliger|^nbb$/i,
  trustUnknownSeller: true, proxy: 'always',
  extra(text, ctx, r) {
    const avail = cleanText(stripTags(firstMatch(text, /product-detail__availability[^>]*>([\s\S]{0,200}?)<\/span>/) ?? ''));
    if (!avail) return null;
    const out = { stockText: avail };
    if (/sofort/i.test(avail) && r.inStock) out.deliveryEstimate = parseDeliveryDate('morgen', ctx.now);
    if (/nicht lieferbar|ausverkauft/i.test(avail)) out.inStock = false;
    return out;
  },
});

// ALTERNATE: JSON-LD offers with seller "ALTERNATE GmbH". Delisted products redirect to productNotFound.xhtml.
export const alternate = jsonLdShop({
  id: 'alternate', name: 'ALTERNATE', hosts: ['alternate.de'], officialSeller: /alternate/i, trustUnknownSeller: true, proxy: 'fallback',
  extra(text) {
    if (/productNotFound\.xhtml/.test(text.slice(0, 20000))) return { ok: false, error: 'not_found' };
    return null;
  },
});

// Galaxus: JSON-LD shows the cheapest offer, often a marketplace seller. The Relay state further down tells us
// "shopOfferType":"MARKETPLACE" vs Galaxus' own stock and the expected delivery window. Akamai Bot Manager.
export const galaxus = {
  ...jsonLdShop({ id: 'galaxus', name: 'Galaxus', hosts: ['galaxus.de'], officialSeller: /galaxus|digitec/i, trustUnknownSeller: false, proxy: 'always', earlyStop: false }),
  request(item) {
    return { url: item.url, headers: BROWSER_HEADERS, stopWhen: (t) => t.includes('"expectedDelivery"') && t.includes('"shopOfferType"') };
  },
  parse(text, ctx) {
    const r = parseStructured(text, ctx);
    if (!r.ok) return r;
    const type = firstMatch(text, /"offer":\{"shopOfferId":\d+,"shopOfferType":"([A-Z_]+)"/) ?? firstMatch(text, /"shopOfferType":"([A-Z_]+)"/);
    const merchant = cleanText(firstMatch(text, /href="\/de\/marketplace\/[^"]+">([^<]+)<\/a>/));
    const from = firstMatch(text, /"expectedDelivery":\{"from":"([^"]+)"/);
    if (from && r.inStock) r.deliveryEstimate = parseDeliveryDate(from, ctx.now);
    const qty = firstMatch(text, /"availableQuantity":(\d+)/);
    if (qty) r.stockText = `${r.stockText ?? ''} qty ${qty}`.trim();
    if (type === 'MARKETPLACE') {
      r.soldBy = merchant ?? 'Galaxus Marketplace';
      r.soldByRetailer = false;
    } else if (type) {
      r.soldBy = 'Galaxus';
      r.soldByRetailer = type !== 'REFURBISHED' && type !== 'SECOND_HAND';
    } else r.soldByRetailer = null;
    return r;
  },
};

// Euronics (Shopware 5): price and stock are not in the server HTML, they load through a JS detail loader.
// Kept as a JSON-LD adapter so it starts working if they add structured data; today it returns parse:no_offer.
export const euronics = jsonLdShop({
  id: 'euronics', name: 'EURONICS', hosts: ['euronics.de'], officialSeller: /euronics/i, trustUnknownSeller: false, proxy: 'fallback', earlyStop: false,
});

// expert (Nuxt): price comes from a client-side call (pricePds/webcode=...;storeId=...). Behind Cloudflare.
// A rendered page says "Das von Ihnen ausgewählte Produkt ist ausverkauft" when sold out, which we read.
export const expert = {
  ...jsonLdShop({ id: 'expert', name: 'expert', hosts: ['expert.de'], officialSeller: /expert/i, trustUnknownSeller: true, proxy: 'always', earlyStop: false }),
  parse(text, ctx) {
    const r = parseStructured(text, ctx);
    if (r.ok) return { ...r, soldBy: r.soldBy ?? 'expert', soldByRetailer: true };
    if (/Produkt ist ausverkauft/i.test(text)) {
      return { ok: true, inStock: false, price: null, soldBy: 'expert', soldByRetailer: true, stockText: 'ausverkauft', title: cleanText(firstMatch(text, /<title>([^<]+)<\/title>/)) };
    }
    return r;
  },
};

// Cyberport (Next.js, Cloudflare challenge seen). Product pages: /pdp/<code>/<slug>.html.
export const cyberport = jsonLdShop({
  id: 'cyberport', name: 'Cyberport', hosts: ['cyberport.de'], officialSeller: /cyberport/i, trustUnknownSeller: true, proxy: 'always', earlyStop: false,
});

// Smyths Toys DE (SAP Commerce). Three fetch attempts through a residential proxy failed on 2026-10-04.
export const smyths = jsonLdShop({
  id: 'smyths', name: 'Smyths Toys', hosts: ['smythstoys.com'], officialSeller: /smyths/i, trustUnknownSeller: true, proxy: 'always', earlyStop: false,
});

// Any other shop URL (Black Week deals): structured data, the site itself as seller unless it is a marketplace.
const MARKETPLACES = /(^|\.)(ebay|kaufland|otto|amazon|galaxus|real|check24|idealo|rakuten|allyouneed|manomano)\./i;
export const generic = {
  id: 'generic',
  name: 'Shop',
  hosts: [],
  officialSeller: null,
  trustUnknownSeller: true,
  defaultIntervalSec: 300,
  proxy: 'fallback',
  request(item) {
    return { url: item.url, headers: BROWSER_HEADERS, stopWhen: null, maxBytes: 3_000_000 };
  },
  parse(text, ctx) {
    const r = parseStructured(text, ctx);
    if (!r.ok) return r;
    const host = hostOf(ctx.item.url);
    if (!r.soldBy) {
      r.soldBy = host;
      r.soldByRetailer = !MARKETPLACES.test(host + '.');
    } else {
      const brand = host.split('.').slice(-2, -1)[0] ?? '';
      r.soldByRetailer = brand ? r.soldBy.toLowerCase().replace(/[^a-z0-9]/g, '').includes(brand.replace(/[^a-z0-9]/g, '')) : null;
    }
    return r;
  },
};
