// Amazon.de. Default path is the "all offers" AJAX endpoint (aodAjaxMain): ~170 KB raw, ~11 KB gzip, and it lists
// every new offer with price, seller and delivery date. The product page is 2.4 MB raw / 430 KB gzip.
// Only offers sold by Amazon itself count as official (seller id A3JWKAKR8XB7XF).
import { BROWSER_HEADERS } from './common.js';
import { parseEuro, parseDeliveryDate, cleanText, stripTags, firstMatch, decodeEntities } from '../util.js';

export const AMAZON_SELLER_ID = 'A3JWKAKR8XB7XF';
const AMAZON_NAME = /^\s*amazon(\.de)?(\s+eu\s+s\.?a\.? ?r\.?l\.?)?\s*$/i;

export function asinOf(url) {
  return firstMatch(String(url), /(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|[?&]asin=)([A-Z0-9]{10})/i)?.toUpperCase() ?? null;
}

export function isAmazonSeller(name, id) {
  return id === AMAZON_SELLER_ID || (name ? AMAZON_NAME.test(name) : false);
}

/** Parse the aodAjaxMain HTML into offers. */
export function parseAodOffers(html, now) {
  const offers = [];
  const starts = [];
  const re = /id="aod-pinned-offer"|id="aod-offer"(?=[\s>])/g;
  let m;
  while ((m = re.exec(html))) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i], starts[i + 1] ?? html.length);
    if (!block.includes('aod-offer-price') && !block.includes('aod-price-')) continue;
    const price =
      parseEuro(firstMatch(block, /apex-pricetopay-accessibility-label">\s*([^<]+?)\s*</)) ??
      parseEuro(firstMatch(block, /class="a-offscreen">\s*([^<]*\d[^<]*)</)) ??
      parseEuro(`${firstMatch(block, /a-price-whole">([\d.]+)/) ?? ''},${firstMatch(block, /a-price-fraction">(\d+)/) ?? '00'}`);
    if (price === null) continue;
    const heading = stripTags(firstMatch(block, /id="aod-offer-heading"[^>]*>([\s\S]*?)<\/div>/) ?? '');
    const sbHtml = block.slice(block.indexOf('id="aod-offer-soldBy"'), block.indexOf('id="aod-offer-soldBy"') + 1500);
    const sellerId = firstMatch(sbHtml, /seller=([A-Z0-9]{10,16})/);
    const linkName = firstMatch(sbHtml, /<a[^>]*>\s*([^<]+?)\s*<\/a>/);
    const spanName = firstMatch(sbHtml, /a-col-right[^>]*>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/);
    const seller = cleanText(linkName ?? spanName ?? null);
    const shipsBlock = block.slice(block.indexOf('id="aod-offer-shipsFrom"'), block.indexOf('id="aod-offer-shipsFrom"') + 1200);
    const shipsFrom = cleanText(firstMatch(shipsBlock, /a-col-right[^>]*>\s*<span[^>]*>\s*([^<]+?)\s*<\/span>/));
    const deliveryText = firstMatch(block, /data-csa-c-delivery-time="([^"]*)"/);
    offers.push({
      price,
      condition: heading || null,
      isNew: !heading || /^neu$|^new$/i.test(heading),
      seller,
      sellerId,
      shipsFrom,
      official: isAmazonSeller(seller, sellerId),
      deliveryText: deliveryText ? decodeEntities(deliveryText) : null,
      deliveryEstimate: deliveryText ? parseDeliveryDate(decodeEntities(deliveryText), now) : null,
    });
  }
  return offers;
}

/** Parse the product page buy box (fallback when aod is not used). */
export function parseDetailPage(html, now) {
  const title = cleanText(stripTags(firstMatch(html, /id="productTitle"[^>]*>([\s\S]*?)<\/span>/) ?? ''));
  const availText = stripTags(firstMatch(html, /id="availability"[^>]*>([\s\S]*?)<\/div>/) ?? '').replace(/\.availability[\s\S]*$/, '').trim();
  let price = null;
  const twister = firstMatch(html, /twister-plus-buying-options-price-data">([\s\S]*?)<\/div>/);
  if (twister) {
    try {
      const j = JSON.parse(decodeEntities(twister));
      const first = Object.values(j)[0]?.find?.((o) => o.buyingOptionType === 'NEW') ?? Object.values(j)[0]?.[0];
      price = typeof first?.priceAmount === 'number' ? first.priceAmount : null;
    } catch {
      /* fall through */
    }
  }
  if (price === null) {
    const core = html.slice(html.indexOf('id="corePrice_feature_div"'), html.indexOf('id="corePrice_feature_div"') + 8000);
    price = parseEuro(firstMatch(core, /class="a-offscreen">\s*([^<]*\d[^<]*)</));
  }
  const merchant = html.slice(html.indexOf('id="merchantInfoFeature_feature_div"'), html.indexOf('id="merchantInfoFeature_feature_div"') + 4000);
  const sellerId = firstMatch(merchant, /seller=([A-Z0-9]{10,16})/);
  let seller = cleanText(stripTags(firstMatch(merchant, /offer-display-feature-text-message[^>]*>([\s\S]*?)<\/(?:span|a)>/) ?? '')) || null;
  if (seller && /^versender|^verk/i.test(seller)) seller = null;
  const deliveryText = firstMatch(html, /data-csa-c-delivery-time="([^"]*)"/);
  const hasCart = html.includes('id="add-to-cart-button"') || html.includes('id="buy-now-button"');
  const unavailable = /derzeit nicht verfügbar|currently unavailable/i.test(availText);
  const isPreorder = /vorbestell|erscheint am|erscheinungstermin|pre-?order/i.test(availText) || html.includes('id="preorderAvailability"');
  const isBackorder = /versandfertig in \d+ bis \d+ (monat|woche)|in \d+ bis \d+ monaten|noch nicht auf lager|temporarily out of stock|vorübergehend nicht auf lager/i.test(availText);
  return {
    title,
    price,
    inStock: hasCart && !unavailable,
    isPreorder,
    isBackorder,
    stockText: availText || null,
    seller,
    sellerId,
    deliveryEstimate: deliveryText ? parseDeliveryDate(decodeEntities(deliveryText), now) : null,
  };
}

export default {
  id: 'amazon',
  name: 'Amazon',
  hosts: ['amazon.de'],
  officialSeller: AMAZON_NAME,
  trustUnknownSeller: false,
  defaultIntervalSec: 60,
  proxy: 'always',

  request(item) {
    const asin = item.asin ?? asinOf(item.url);
    if (item.amazonMode === 'dp' || !asin) {
      return { url: asin ? `https://www.amazon.de/dp/${asin}` : item.url, headers: BROWSER_HEADERS, maxBytes: 1_200_000 };
    }
    return {
      url: `https://www.amazon.de/gp/product/ajax/aodAjaxMain/?asin=${asin}&pc=dp&experienceId=aodAjaxMain`,
      headers: { ...BROWSER_HEADERS, accept: 'text/html,*/*', 'x-requested-with': 'XMLHttpRequest', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', referer: `https://www.amazon.de/dp/${asin}` },
    };
  },

  parse(text, ctx) {
    const now = ctx.now;
    if (text.includes('aod-container') || text.includes('id="aod-offer"')) {
      const title = cleanText(stripTags(firstMatch(text, /id="aod-asin-title-text"[^>]*>([\s\S]*?)<\/h5>/) ?? '')) || ctx.item.title || null;
      const offers = parseAodOffers(text, now).filter((o) => o.isNew);
      const official = offers.filter((o) => o.official).sort((a, b) => a.price - b.price)[0];
      const best = official ?? offers.sort((a, b) => a.price - b.price)[0];
      if (!best) return { ok: true, title, inStock: false, price: null, soldBy: null, soldByRetailer: null, stockText: 'keine neuen Angebote' };
      return {
        ok: true,
        title,
        price: best.price,
        inStock: true,
        soldBy: best.seller ?? (best.official ? 'Amazon' : null),
        soldByRetailer: best.official,
        deliveryEstimate: best.deliveryEstimate,
        stockText: [best.deliveryText ? `Lieferung ${best.deliveryText}` : null, official ? null : `${offers.length} Drittanbieter-Angebote`].filter(Boolean).join(', ') || null,
        offerCount: offers.length,
      };
    }
    if (text.includes('id="productTitle"')) {
      const d = parseDetailPage(text, now);
      const official = isAmazonSeller(d.seller, d.sellerId);
      return { ok: true, title: d.title, price: d.price, inStock: d.inStock, isPreorder: d.isPreorder, isBackorder: d.isBackorder, soldBy: d.seller, soldByRetailer: d.seller || d.sellerId ? official : null, deliveryEstimate: d.deliveryEstimate, stockText: d.stockText };
    }
    return { ok: false, error: 'parse:no_offer' };
  },
};
