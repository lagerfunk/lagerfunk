// German price-advertising rules (PAngV) applied to one alert. Pure function: decides WHAT may be said.
//
// Hard rules:
//  1. Never a percent discount, never "statt", never a crossed-out old price.
//  2. "UVP x €" only when the list price is the manufacturer's recommended retail price
//     (alert.listPriceType === 'uvp', or the retailer config says its listPrice field is UVP).
//  3. "Tiefster Preis der letzten 30 Tage" only when lowest30d comes from OUR OWN history covering 30 days
//     and price <= lowest30d.
//  4. No Amazon prices unless cfg.amazonPriceAllowed (Amazon only permits prices pulled live from its API).
import { parsePrice, toMs } from './util.js';
import { isAmazonUrl } from './affiliate.js';

const DAY = 86400000;

export function priceFacts(alert, retailer, cfg, now) {
  const amazon = retailer?.program === 'amazon' || isAmazonUrl(alert.url);
  const pricesHidden = amazon && !cfg.amazonPriceAllowed;
  const price = parsePrice(alert.price);
  const listPrice = parsePrice(alert.listPrice);
  const lowest30d = parsePrice(alert.lowest30d);

  if (pricesHidden) {
    return { amazon, pricesHidden: true, price: null, uvp: null, lowest30dClaim: false, reasons: ['amazon-price-hidden'] };
  }

  const reasons = [];

  // Rule 2: UVP
  let uvp = null;
  const lpType = String(alert.listPriceType ?? '').toLowerCase();
  const isUvp = lpType ? lpType === 'uvp' : retailer?.listPriceIsUvp === true;
  if (listPrice !== null && price !== null && isUvp && listPrice > price) uvp = listPrice;
  else if (listPrice !== null) reasons.push(isUvp ? 'uvp-not-above-price' : 'listprice-not-uvp');

  // Rule 3: 30-day low, own history only
  let lowest30dClaim = false;
  if (lowest30d !== null && price !== null) {
    const src = String(alert.lowest30dSource ?? 'own').toLowerCase();
    const historyDays = Number(alert.historyDays);
    const firstSeen = toMs(alert.firstSeenAt ?? alert.historySince, null);
    const historyOk =
      (Number.isFinite(historyDays) && historyDays >= 30) ||
      (firstSeen !== null && now - firstSeen >= 30 * DAY) ||
      cfg.trustLowest30dWithoutHistory === true;
    if (src !== 'own') reasons.push('lowest30d-not-own');
    else if (!historyOk) reasons.push('history-under-30d');
    else if (price > lowest30d) reasons.push('price-above-lowest30d');
    else lowest30dClaim = true;
  }

  return { amazon, pricesHidden: false, price, uvp, lowest30dClaim, reasons };
}

// Belt and braces: any rendered text is checked before it goes out.
const PERCENT = /\d\s*%|%\s*\d|prozent|\bstatt\b|\bvorher\b|\bspar(e|en|st)?\b/i;
export function assertCompliant(text) {
  if (PERCENT.test(text)) throw new Error(`Compliance: forbidden price wording in post: ${text.slice(0, 120)}`);
}
