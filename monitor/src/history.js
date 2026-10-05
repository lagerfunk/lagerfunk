// Price history per watch item: one row per Berlin calendar day (min, max, last in-stock price from an official
// seller), 31 days kept. `since` marks when we first checked the item at all, so the bot can tell whether a
// "lowest price in 30 days" claim is backed by a full 30 days of our own data (PAngV §11).
// Writes happen only when a day row changes, so the store sees about one write per day per item plus price changes.
import { berlinDate, dayDiff, DAY_MS } from './util.js';

export const KEEP_DAYS = 31;
export const historyKey = (retailer, productKey) => `hist:${retailer}:${productKey}`;

export function emptyHistory(nowMs) {
  return { v: 1, since: new Date(nowMs).toISOString(), days: {} };
}

/** Summary used by the rules, computed BEFORE the current observation is added. */
export function summarize(hist, nowMs, windowDays = 30) {
  if (!hist) return { lowest30d: null, historyDays: 0, firstSeenAt: null, lastPrice: null };
  const today = berlinDate(nowMs);
  let lowest = null;
  let lastPrice = null;
  let lastDay = '';
  for (const [day, row] of Object.entries(hist.days ?? {})) {
    const age = dayDiff(day, today);
    if (age < 0 || age > windowDays) continue;
    if (lowest === null || row.min < lowest) lowest = row.min;
    if (day > lastDay) {
      lastDay = day;
      lastPrice = row.last;
    }
  }
  const since = Date.parse(hist.since);
  return {
    lowest30d: lowest,
    historyDays: Number.isFinite(since) ? Math.floor((nowMs - since) / DAY_MS) : 0,
    firstSeenAt: hist.since ?? null,
    lastPrice,
  };
}

/**
 * Add an observation. Returns { hist, changed }. Only prices a buyer could actually pay count:
 * ok, in stock, price known, sold by the retailer itself (or a trusted unknown seller).
 */
export function addObservation(hist, nowMs, { price, countable }) {
  let changed = false;
  if (!hist) {
    hist = emptyHistory(nowMs);
    changed = true;
  }
  if (countable && typeof price === 'number') {
    const day = berlinDate(nowMs);
    const row = hist.days[day];
    if (!row) {
      hist.days[day] = { min: price, max: price, last: price };
      changed = true;
    } else {
      if (price < row.min) (row.min = price), (changed = true);
      if (price > row.max) (row.max = price), (changed = true);
      if (price !== row.last) (row.last = price), (changed = true);
    }
  }
  const today = berlinDate(nowMs);
  for (const day of Object.keys(hist.days)) {
    if (dayDiff(day, today) > KEEP_DAYS) {
      delete hist.days[day];
      changed = true;
    }
  }
  return { hist, changed };
}
