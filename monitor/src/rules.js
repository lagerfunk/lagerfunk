// Turns one Check plus remembered state into at most ONE alert per item per check, so the channel never gets two
// posts for the same event. Priority: ships_before > restock > lowest_30d > price_drop.
import { DAY_MS } from './util.js';

export const DEFAULTS = {
  shipsBy: '2026-11-18', // the day before GTA VI (2026-11-19)
  // "Lieferung vor GTA VI" only means something for consoles and games. RAM, SSDs, GPUs and the rest never get a
  // ships_before alert (found in staging 2026-10-08: an always-in-stock SSD was posted as "ships before GTA VI").
  // Items without a category keep the old behaviour. An explicit item.shipsBy always applies.
  shipsByCategories: ['console', 'game'],
  rearmMinutes: 20, // an offer must be gone this long before a new restock alert (stops flapping spam)
  minDropPct: 0.03,
  minDropEur: 10,
  minHistoryDays: 30, // lowest_30d only with 30 full days of our own data
  lowestRepeatHours: 12, // same 30-day low price is not re-announced within this window
};

export const stateKey = (retailer, productKey) => `state:${retailer}:${productKey}`;

/** Is the seller acceptable for alerts: the retailer itself, the official store, or an unknown seller at a shop without marketplace. */
export function sellerOk(check, adapter) {
  if (check.soldByRetailer === true) return true;
  if (check.soldByRetailer === false) return false;
  return Boolean(adapter?.trustUnknownSeller);
}

/**
 * @returns {{ alert: object|null, state: object, changed: boolean, flags: object }}
 */
export function evaluate({ item, check, prev, hist, adapter, now, options = {} }) {
  const o = { ...DEFAULTS, ...options };
  const p = prev ?? {};
  const nowMs = typeof now === 'number' ? now : Date.parse(check.checkedAt);
  const state = { ...p };

  if (!check.ok) {
    // Failed checks never change stock state: a block must not look like "sold out" and then a fake restock.
    state.lastError = check.error;
    return { alert: null, state, changed: p.lastError !== check.error, flags: {} };
  }
  state.lastError = null;

  const threshold = num(item.threshold);
  const gtaRelevant = !item.category || o.shipsByCategories.includes(item.category);
  const shipsBy = item.shipsBy ?? (gtaRelevant ? o.shipsBy : null);
  const price = check.price;
  const seller = sellerOk(check, adapter);
  const underThreshold = threshold === null || (price !== null && price <= threshold);
  const buyable = check.inStock === true && price !== null && seller;
  const eligible = buyable && underThreshold;
  const shipsEligible = eligible && !!shipsBy && !!check.deliveryEstimate && check.deliveryEstimate <= shipsBy;

  const base = {
    productKey: check.productKey,
    retailer: check.retailer,
    title: check.title ?? item.title ?? null,
    url: check.url,
    price,
    listPrice: num(item.listPrice),
    lowest30d: hist?.lowest30d ?? null,
    detectedAt: check.checkedAt,
    inStock: check.inStock,
    stockText: check.stockText,
    soldBy: check.soldBy,
    deliveryEstimate: check.deliveryEstimate,
    deliveryAssumed: check.deliveryAssumed,
    isPreorder: check.isPreorder,
    isBackorder: check.isBackorder,
    shipsBy,
    historyDays: hist?.historyDays ?? 0,
    firstSeenAt: hist?.firstSeenAt ?? null,
    lowest30dSource: 'own',
    listPriceType: item.listPriceType ?? null,
    imageUrl: check.imageUrl ?? null,
  };

  // Re-arm logic for restock: the item must have been non-eligible for rearmMinutes.
  const ineligibleSince = eligible ? null : p.eligible === false && p.ineligibleSince ? p.ineligibleSince : check.checkedAt;
  const armed = p.eligible !== true && (!p.ineligibleSince || nowMs - Date.parse(p.ineligibleSince) >= o.rearmMinutes * 60000 || p.everEligible !== true);

  let alert = null;
  const id = `${check.retailer}:${check.productKey}`;
  const cents = price !== null ? Math.round(price * 100) : 'na';

  if (shipsEligible && (p.shipsEligible !== true) && (armed || p.eligible === true)) {
    alert = { key: `ships_before:${id}:${check.deliveryEstimate}:${cents}:${minuteOf(check.checkedAt)}`, kind: 'ships_before', ...base };
  } else if (eligible && armed) {
    alert = { key: `restock:${id}:${minuteOf(check.checkedAt)}`, kind: 'restock', ...base };
  } else if (buyable && underThreshold && hist && hist.lowest30d !== null && hist.historyDays >= o.minHistoryDays && price < hist.lowest30d &&
    !(p.lastLowAlertPrice === price && p.lastLowAlertAt && nowMs - Date.parse(p.lastLowAlertAt) < o.lowestRepeatHours * 3600000)) {
    alert = { key: `lowest_30d:${id}:${cents}:${check.checkedAt.slice(0, 10)}`, kind: 'lowest_30d', ...base };
    state.lastLowAlertPrice = price;
    state.lastLowAlertAt = check.checkedAt;
  } else if (buyable && underThreshold && typeof p.lastGoodPrice === 'number' && price < p.lastGoodPrice) {
    const drop = p.lastGoodPrice - price;
    if (drop >= o.minDropEur && drop / p.lastGoodPrice >= o.minDropPct && !(typeof item.minDropPct === 'number' && drop / p.lastGoodPrice < item.minDropPct) && !(typeof item.minDropEur === 'number' && drop < item.minDropEur)) {
      alert = { key: `price_drop:${id}:${cents}:${check.checkedAt.slice(0, 10)}`, kind: 'price_drop', previousPrice: p.lastGoodPrice, ...base };
    }
  }

  state.inStock = check.inStock;
  state.price = price;
  state.deliveryEstimate = check.deliveryEstimate;
  state.eligible = eligible;
  state.shipsEligible = shipsEligible;
  state.ineligibleSince = ineligibleSince;
  if (eligible) state.everEligible = true;
  if (buyable) state.lastGoodPrice = price;
  state.lastOkAt = check.checkedAt;

  const changed = ['inStock', 'price', 'deliveryEstimate', 'eligible', 'shipsEligible', 'ineligibleSince', 'everEligible', 'lastGoodPrice', 'lastLowAlertPrice', 'lastError']
    .some((k) => p[k] !== state[k]) || !p.lastOkAt || nowMs - Date.parse(p.lastOkAt) > DAY_MS;

  return { alert, state, changed, flags: { eligible, shipsEligible, buyable, sellerOk: seller } };
}

function num(v) {
  return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
}

function minuteOf(iso) {
  return iso.slice(0, 16);
}
