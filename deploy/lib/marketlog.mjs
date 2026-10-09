// The runner's own measurements for the weekly market report (deploy/lib/marketreport.mjs), kept in the state under
// market:log. Per watch item (shop + product) it keeps:
//   f    first reading (minutes since 1970), x latest reading
//   s    the latest reading: t (minute), a (1 = buyable: in stock, price known, sold by the shop itself), p (price in cents),
//        d (delivery date YYYY-MM-DD), da (1 = delivery date assumed), po (1 = pre-order)
//   seg  buyable stretches [start, end, cents] (minutes). A price change while buyable starts a new stretch marked
//        [start, end, cents, 1] ("continues the one before"). A stretch ends at the last reading that saw it buyable, so
//        every hour count built from it is a minimum: the time between two checks is never guessed.
//   o    out of stock (or not buyable) since, null while buyable
//   r    restock moments: buyable again after at least restockMinOutMinutes without
// Only successful checks count. Amazon is never recorded. Prices the price breaker holds never get here (the runner
// leaves those readings out), so a wrong number cannot become part of the week.
import { sellerOk } from '../../monitor/src/rules.js';
import { isAmazonUrl } from '../../bot/src/affiliate.js';

export const MARKET_LOG_KEY = 'market:log';
export const MIN = 60000;
const MAX_SEGMENTS = 200; // about 6 KB per item at the most (a shop that flaps all week); older stretches go first, so hours stay minimums
const MAX_RESTOCKS = 100;

/** Amazon rows never enter the market report, by shop id or by link. `extra` adds more shop ids. */
export function isExcluded(retailer, url, extra = []) {
  const r = String(retailer ?? '').toLowerCase();
  return r === 'amazon' || isAmazonUrl(url ?? '') || extra.map((x) => String(x).toLowerCase()).includes(r);
}

export function emptyLog() {
  return { v: 1, items: {} };
}

export function loadLog(raw) {
  return raw && raw.v === 1 && raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items) ? raw : emptyLog();
}

/**
 * Add this run's checks. Pure: returns a new log.
 * @param {object|null} raw      the stored market:log
 * @param {object[]} checks       Check objects of this run (failed ones are skipped)
 * @param {object} o
 * @param {Map<string,object>} o.items   `${retailer}:${productKey}` -> watch item (_adapter, url, intervalSec)
 * @param {object} o.cfg          ops.marketReport
 * @param {number} o.now          ms, for pruning
 * @param {string[]} [o.exclude]  more shop ids to leave out
 */
export function recordChecks(raw, checks, { items = new Map(), cfg, now, exclude = [] }) {
  const log = structuredClone(loadLog(raw));
  const sorted = [...(checks ?? [])].filter((c) => c && c.ok && typeof c.inStock === 'boolean').sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt));
  for (const c of sorted) {
    const id = `${c.retailer}:${c.productKey}`;
    const item = items.get(id) ?? null;
    if (isExcluded(c.retailer, c.url, exclude) || (item && isExcluded(item.retailer, item.url, exclude))) continue;
    const t = Math.floor(Date.parse(c.checkedAt) / MIN);
    if (!Number.isFinite(t)) continue;
    const e = (log.items[id] ??= { f: t, x: t, s: null, o: null, seg: [], r: [] });
    if (e.s && t < e.s.t) continue; // an older reading than the one we have
    const buyable = c.inStock === true && typeof c.price === 'number' && Number.isFinite(c.price) && sellerOk(c, item?._adapter);
    const cents = buyable ? Math.round(c.price * 100) : null;
    const gap = Math.max(cfg.maxGapMinutes, Math.ceil((2 * (Number(item?.intervalSec) || 0)) / 60));
    if (buyable) {
      const last = e.seg.at(-1);
      const continuing = Boolean(last && e.s?.a === 1 && last[1] === e.s.t && t - last[1] <= gap);
      if (continuing && last[2] === cents) last[1] = t;
      else e.seg.push(continuing ? [t, t, cents, 1] : [t, t, cents]);
      if (e.o !== null && e.o !== undefined && t - e.o >= cfg.restockMinOutMinutes) e.r.push(t);
      e.o = null;
    } else if (e.o === null || e.o === undefined) {
      e.o = t;
    }
    e.s = { t, a: buyable ? 1 : 0, p: cents, d: buyable && c.deliveryEstimate ? String(c.deliveryEstimate).slice(0, 10) : null, da: c.deliveryAssumed ? 1 : 0, po: c.isPreorder ? 1 : 0 };
    e.x = t;
  }
  return pruneLog(log, { now, keepDays: cfg.keepDays });
}

/** Drop what is older than keepDays, and items not read for that long. */
export function pruneLog(log, { now, keepDays }) {
  const cut = Math.floor(now / MIN) - keepDays * 1440;
  for (const [id, e] of Object.entries(log.items)) {
    if (!(e.x >= cut)) {
      delete log.items[id];
      continue;
    }
    e.seg = e.seg.filter((s) => s[1] >= cut).slice(-MAX_SEGMENTS);
    if (e.seg[0]?.[3]) e.seg[0] = e.seg[0].slice(0, 3); // the stretch it continued is gone
    e.r = e.r.filter((x) => x >= cut).slice(-MAX_RESTOCKS);
  }
  return log;
}

/**
 * Buyable stretches of one item as [start, end] minutes. `ref` (cents) keeps only stretches at or below that price.
 * Stretches marked "continues" are joined to the one before when both count.
 */
export function stretches(entry, ref = null) {
  const out = [];
  let prevKept = false;
  for (const s of entry?.seg ?? []) {
    const keep = ref === null || s[2] <= ref;
    if (keep && s[3] && prevKept && out.length) out[out.length - 1][1] = s[1];
    else if (keep) out.push([s[0], s[1]]);
    prevKept = keep;
  }
  return out;
}

/**
 * Minutes inside [from, to] (minutes) in which at least one of `entries` was buyable (at or below `ref` cents, if given).
 * Overlaps between shops count once.
 */
export function buyableMinutes(entries, from, to, ref = null) {
  const all = entries.flatMap((e) => stretches(e, ref)).map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let sum = 0;
  let cur = null;
  for (const [a, b] of all) {
    if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else {
      if (cur) sum += cur[1] - cur[0];
      cur = [a, b];
    }
  }
  if (cur) sum += cur[1] - cur[0];
  return sum;
}
