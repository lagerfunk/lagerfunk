// Circuit breakers. Pure functions over one state object that the runner keeps in the store (key runner:breakers),
// so a trip survives between runs and shows on the state branch. Every threshold comes from deploy/config/breakers.json.
//
// On a trip the runner does four things, always in this order: PAUSE (the shop, the posts or Telegram), PRESERVE STATE
// (nothing is deleted, held posts are kept in runner:held), ALERT (admin chat, deduplicated) and DIAGNOSE (a one-line
// cause and next step, see diagnose()).
//
//   retailer   N failed checks in a row for one shop: stop fetching it, back off exponentially, then one probe request.
//   surge      more products flipped to "in stock" in one run than any real restock produces: a parser broke. Hold
//              every public post of that run, keep holding that shop's posts for a while.
//   price      a price far below (or far above) the 30-day median, or no price: hold that post and keep the reading
//              out of the price history (a wrong low would poison every later "lowest price in 30 days" claim).
//   telegram   token revoked or bot removed (401/403): stop sending at once. Long 429 or repeated errors: back off.
//              Half open: one getMe call decides.
//   dedupe     one post per product and event: kind + shop + product + price, inside a window per kind.
import { berlinDate } from '../../monitor/src/util.js';

export const BREAKERS_KEY = 'runner:breakers';
export const LEDGER_KEY = 'runner:posted';
export const HELD_KEY = 'runner:held';
const MIN = 60000;
const RESTOCK_KINDS = new Set(['restock', 'ships_before']);

export function emptyBreakers() {
  return {
    v: 1,
    retailers: {},
    surge: { latched: {}, trips: 0, lastTripAt: null },
    telegram: { state: 'closed', kind: null, failedRuns: 0, trips: 0, openedAt: null, openUntil: 0, lastError: null },
    quarantine: {},
  };
}

/** Fill in anything an older state lacks. */
export function loadBreakers(v) {
  const e = emptyBreakers();
  if (!v || typeof v !== 'object') return e;
  return {
    ...e,
    ...v,
    retailers: { ...(v.retailers ?? {}) },
    surge: { ...e.surge, ...(v.surge ?? {}), latched: { ...(v.surge?.latched ?? {}) } },
    telegram: { ...e.telegram, ...(v.telegram ?? {}) },
    quarantine: { ...(v.quarantine ?? {}) },
  };
}

const backoffMs = (trips, baseMin, maxMin) => Math.min(maxMin, baseMin * 2 ** Math.max(0, trips - 1)) * MIN;

/** One line: what the error usually means and what to do. Used in logs and admin alerts. */
export function diagnose(error) {
  const e = String(error ?? '');
  if (/^blocked:|^http_403|^blocked/.test(e)) return 'The shop blocks our requests (anti-bot wall). Do not work around it: wait for the probe, or move the shop to its affiliate feed. RUNBOOK: retailer layout change or block.';
  if (e === 'rate_limited') return 'The shop rate-limits us. The breaker doubles the pause on every failed probe. Nothing to do unless it lasts a day.';
  if (/^parse:/.test(e)) return 'The page loads but the parser finds no offer: the shop changed its layout. Save the page as a fixture, fix the adapter in monitor/src/adapters, add a test. RUNBOOK: retailer layout change.';
  if (/^http_5\d\d$/.test(e)) return 'The shop answers with server errors. Usually its own outage: wait for the probe.';
  if (e === 'timeout' || /^network/.test(e)) return 'Timeouts or network errors from the runner to the shop. Usually transient on GitHub runners.';
  if (e === 'queue_active') return 'The shop has a waiting room (queue) up. We never bypass it. The probe resumes when it is gone.';
  if (/^feed:/.test(e)) return 'The affiliate feed download or its format failed. Check the feed link secret and the network status page. RUNBOOK: affiliate network down.';
  if (e === 'not_found') return 'The product page is gone (404). Update the URL in watchlist/watchlist.json.';
  return 'Unknown failure. Open the run log and search for this shop.';
}

// ---------- retailer ----------

/**
 * Which shops sit out this run, and which get one probe. Moves "open" shops whose wait is over to "half_open".
 * @returns {{ skip: Set<string>, probe: Set<string> }}
 */
export function retailerPlan(b, now) {
  const skip = new Set();
  const probe = new Set();
  for (const [id, r] of Object.entries(b.retailers)) {
    if (r.state === 'open' && now < r.openUntil) skip.add(id);
    else if (r.state === 'open' || r.state === 'half_open') {
      r.state = 'half_open';
      probe.add(id);
    }
  }
  return { skip, probe };
}

/** The item a half-open shop is probed with: rotates through its scraped items so one dead page cannot keep it shut. */
export function pickProbe(items, retailer, b) {
  const list = items.filter((i) => i.retailer === retailer && i._source !== 'feed');
  if (!list.length) return null;
  const n = b.retailers[retailer]?.probes ?? 0;
  return list[n % list.length];
}

/** Results per shop, in order: one per scraped check, one per feed download (not one per feed item). */
export function collectRetailerResults({ scrapeChecks = [], feeds = [] } = {}) {
  const m = new Map();
  const add = (r, x) => {
    if (!m.has(r)) m.set(r, []);
    m.get(r).push(x);
  };
  for (const c of scrapeChecks) add(c.retailer, { ok: c.ok, error: c.ok ? null : c.error ?? 'unknown' });
  for (const f of feeds) {
    if (f.status === 'ok') add(f.retailer, { ok: true, error: null });
    else if (f.status === 'error') add(f.retailer, { ok: false, error: f.reason ?? 'feed:error' });
  }
  return m;
}

/**
 * Apply one run's results. Returns events: { type: 'trip' | 'reopen' | 'recover', retailer, ... }.
 */
export function updateRetailers(b, results, now, cfg) {
  const c = cfg.retailer;
  const ignore = new Set(c.ignoreErrors ?? []);
  const events = [];
  for (const [id, list] of results) {
    const rel = list.filter((x) => x.ok || !ignore.has(x.error));
    if (!rel.length) continue;
    const r = (b.retailers[id] ??= { state: 'closed', failures: 0, trips: 0, probes: 0, openedAt: null, openUntil: 0, lastError: null, lastOkAt: null });
    const lastOk = rel.map((x) => x.ok).lastIndexOf(true);
    const lastErr = [...rel].reverse().find((x) => !x.ok)?.error ?? r.lastError;
    if (lastOk >= 0) r.lastOkAt = new Date(now).toISOString();
    if (r.state === 'half_open') {
      r.probes = (r.probes ?? 0) + 1;
      if (lastOk >= 0) {
        const downMin = r.openedAt ? Math.round((now - Date.parse(r.openedAt)) / MIN) : null;
        events.push({ type: 'recover', retailer: id, trips: r.trips, downMinutes: downMin });
        Object.assign(r, { state: 'closed', failures: rel.length - 1 - lastOk, trips: 0, openedAt: null, openUntil: 0 });
      } else {
        r.trips += 1;
        r.lastError = lastErr;
        r.openUntil = now + backoffMs(r.trips, c.openMinutes, c.maxOpenMinutes);
        r.state = 'open';
        events.push({ type: 'reopen', retailer: id, trips: r.trips, error: lastErr, openUntil: new Date(r.openUntil).toISOString(), diagnose: diagnose(lastErr) });
      }
      continue;
    }
    r.failures = lastOk >= 0 ? rel.length - 1 - lastOk : r.failures + rel.length;
    if (lastErr && rel.some((x) => !x.ok)) r.lastError = lastErr;
    if (r.state === 'closed' && r.failures >= c.tripAfterFailures) {
      r.trips = 1;
      r.state = 'open';
      r.openedAt = new Date(now).toISOString();
      r.openUntil = now + backoffMs(1, c.openMinutes, c.maxOpenMinutes);
      events.push({ type: 'trip', retailer: id, failures: r.failures, error: r.lastError, openUntil: new Date(r.openUntil).toISOString(), diagnose: diagnose(r.lastError) });
    }
  }
  return events;
}

export const openRetailers = (b) => Object.entries(b.retailers).filter(([, r]) => r.state !== 'closed').map(([id]) => id).sort();

// ---------- surge ----------

/**
 * @returns {{ hold: Map<string,string>, event: object|null }} hold: alert key -> reason
 */
export function surgeCheck(alerts, b, now, cfg) {
  const c = cfg.surge;
  for (const [r, until] of Object.entries(b.surge.latched)) if (until <= now) delete b.surge.latched[r];
  const flips = new Map();
  for (const a of alerts) {
    if (!RESTOCK_KINDS.has(a.kind)) continue;
    if (!flips.has(a.retailer)) flips.set(a.retailer, new Set());
    flips.get(a.retailer).add(a.productKey);
  }
  const perRetailer = Object.fromEntries([...flips].map(([r, s]) => [r, s.size]));
  const total = Object.values(perRetailer).reduce((n, x) => n + x, 0);
  const hold = new Map();
  const worst = Object.entries(perRetailer).sort((a, b2) => b2[1] - a[1])[0];
  if (total > c.maxInStockFlipsPerRun || (worst && worst[1] > c.maxInStockFlipsPerRetailer)) {
    for (const r of flips.keys()) b.surge.latched[r] = now + c.holdMinutes * MIN;
    b.surge.trips += 1;
    b.surge.lastTripAt = new Date(now).toISOString();
    for (const a of alerts) hold.set(a.key, 'surge');
    return {
      hold,
      event: {
        type: 'trip', breaker: 'surge', total, perRetailer, held: alerts.length, holdUntil: new Date(now + c.holdMinutes * MIN).toISOString(),
        diagnose: `${total} products flipped to in stock in one run (limit ${c.maxInStockFlipsPerRun}, per shop ${c.maxInStockFlipsPerRetailer}). Usually a parser or feed broke, not a real restock. Posts are held. If it is real, run the workflow with release_held within the hour. RUNBOOK: false alert posted.`,
      },
    };
  }
  for (const a of alerts) if (b.surge.latched[a.retailer] > now) hold.set(a.key, 'surge-latch');
  return { hold, event: null };
}

// ---------- price ----------

export function medianOf(nums) {
  const s = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Reference price: median of the daily lows of the last 30 days BEFORE today, else the list price, else the threshold. */
export function priceReference(hist, item, day, cfg) {
  const rows = Object.entries(hist?.days ?? {}).filter(([d]) => d < day && dayGap(d, day) <= 30).map(([, r]) => r.min);
  if (rows.length >= cfg.price.minHistoryDays) return { reference: medianOf(rows), source: 'median30d', days: rows.length };
  const lp = Number(item?.listPrice);
  if (item?.listPrice !== null && item?.listPrice !== undefined && Number.isFinite(lp) && lp > 0) return { reference: lp, source: 'listPrice', days: rows.length };
  const th = Number(item?.threshold);
  if (item?.threshold !== null && item?.threshold !== undefined && Number.isFinite(th) && th > 0) return { reference: th, source: 'threshold', days: rows.length };
  return { reference: null, source: null, days: rows.length };
}

function dayGap(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

/**
 * Is this in-stock price believable? null = yes. Otherwise { reason, price, reference, source }.
 * reason: price_missing | price_low | price_high
 */
export function priceVerdict({ price, checkedAt }, item, hist, cfg) {
  if (price === null || price === undefined || !Number.isFinite(Number(price))) return { reason: 'price_missing', price: null, reference: null, source: null };
  const p = Number(price);
  const ref = priceReference(hist, item, berlinDate(Date.parse(checkedAt)), cfg);
  if (p <= 0) return { reason: 'price_low', price: p, ...ref };
  if (ref.reference === null) return null;
  if (p < (ref.reference * cfg.price.minPctOfMedian) / 100) return { reason: 'price_low', price: p, ...ref };
  if (cfg.price.maxPctOfMedian > 0 && p > (ref.reference * cfg.price.maxPctOfMedian) / 100) return { reason: 'price_high', price: p, ...ref };
  return null;
}

// ---------- telegram ----------

const AUTH = /chat not found|bot was kicked|not enough rights|have no rights|need administrator|CHAT_WRITE_FORBIDDEN|bot is not a member|USER_DEACTIVATED/i;

export function classifyTelegramFailure(f) {
  if (f.status === 0 && /^link:/.test(f.error ?? '')) return 'link';
  if (f.status === 401 || f.status === 403 || (f.status === 400 && AUTH.test(f.error ?? ''))) return 'auth';
  if (f.status === 429) return 'rate_limit';
  return 'error';
}

/** 'send' | 'hold' | 'probe'. A probe is due when an open breaker's wait is over. */
export function telegramPlan(b, now) {
  const t = b.telegram;
  if (t.state === 'closed') return 'send';
  if (now < t.openUntil) return 'hold';
  t.state = 'half_open';
  return 'probe';
}

function openTelegram(t, kind, now, minutes, cfg, error) {
  const was = t.state;
  t.lastError = error;
  if (was === 'open' && t.kind === kind) return was; // already open for this reason: the wait stands
  t.trips = (was === 'half_open' && t.kind === kind ? t.trips : 0) + 1; // a failed probe doubles the wait
  t.kind = kind;
  t.state = 'open';
  t.openedAt ??= new Date(now).toISOString();
  t.openUntil = now + backoffMs(t.trips, minutes, cfg.telegram.maxOpenMinutes);
  return was;
}

/** Outcome of the getMe probe. Returns an event. */
export function telegramAfterProbe(b, { ok, status = 0, error = null }, now, cfg) {
  const t = b.telegram;
  if (ok) {
    const downMin = t.openedAt ? Math.round((now - Date.parse(t.openedAt)) / MIN) : null;
    Object.assign(t, { state: 'closed', kind: null, failedRuns: 0, trips: 0, openedAt: null, openUntil: 0 });
    return { type: 'recover', breaker: 'telegram', downMinutes: downMin };
  }
  const kind = status === 401 || status === 403 ? 'auth' : 'error';
  openTelegram(t, kind, now, kind === 'auth' ? cfg.telegram.authOpenMinutes : cfg.telegram.openMinutes, cfg, error);
  return { type: 'reopen', breaker: 'telegram', kind, trips: t.trips, error, openUntil: new Date(t.openUntil).toISOString() };
}

/**
 * Apply one run's send results ({ sent: [], failed: [{status, error, retryAfter}] }). Returns events.
 */
export function telegramUpdate(b, bot, now, cfg) {
  const t = b.telegram;
  const events = [];
  const fails = (bot?.failed ?? []).map((f) => ({ ...f, cls: classifyTelegramFailure(f) })).filter((f) => f.cls !== 'link');
  const sent = bot?.sent?.length ?? 0;
  const auth = fails.find((f) => f.cls === 'auth');
  if (auth) {
    const was = openTelegram(t, 'auth', now, cfg.telegram.authOpenMinutes, cfg, auth.error);
    if (was === 'closed') events.push({ type: 'trip', breaker: 'telegram', kind: 'auth', error: auth.error, openUntil: new Date(t.openUntil).toISOString(), diagnose: 'Telegram refuses the bot: token revoked, or the bot lost its admin rights in the channel. Posting is paused. RUNBOOK: Telegram token revoked.' });
    return events;
  }
  const long = fails.filter((f) => f.cls === 'rate_limit' && (f.retryAfter ?? 0) > cfg.telegram.longRetryAfterSec);
  if (long.length) {
    const ra = Math.max(...long.map((f) => f.retryAfter));
    const was = t.state;
    t.state = 'open';
    t.kind = 'rate_limit';
    t.openedAt ??= new Date(now).toISOString();
    t.openUntil = Math.max(t.openUntil || 0, now + ra * 1000);
    t.lastError = long[0].error;
    if (was === 'closed') events.push({ type: 'trip', breaker: 'telegram', kind: 'rate_limit', retryAfterSec: ra, openUntil: new Date(t.openUntil).toISOString(), diagnose: `Telegram asked us to wait ${ra} s (429). Posts stay queued and go out after the wait. Nothing is resent early.` });
    return events;
  }
  if (fails.length && sent === 0) {
    t.failedRuns += 1;
    t.lastError = fails[0].error;
    if (t.state === 'half_open' || (t.state === 'closed' && t.failedRuns >= cfg.telegram.tripAfterFailedRuns)) {
      const was = openTelegram(t, 'error', now, cfg.telegram.openMinutes, cfg, fails[0].error);
      if (was === 'closed') events.push({ type: 'trip', breaker: 'telegram', kind: 'error', failedRuns: t.failedRuns, error: fails[0].error, openUntil: new Date(t.openUntil).toISOString(), diagnose: 'Telegram failed in several runs in a row (5xx or network). Posts stay queued; one probe decides when to resume.' });
    }
    return events;
  }
  if (sent > 0) {
    t.failedRuns = 0;
    if (t.state !== 'closed') {
      const downMin = t.openedAt ? Math.round((now - Date.parse(t.openedAt)) / MIN) : null;
      Object.assign(t, { state: 'closed', kind: null, trips: 0, openedAt: null, openUntil: 0 });
      events.push({ type: 'recover', breaker: 'telegram', downMinutes: downMin });
    }
  }
  return events;
}

// ---------- dedupe (idempotency) ----------

/** One key per product and event: the same kind, shop, product and price is the same news. */
export function idemKey(a) {
  const n = Number(a.price);
  const cents = a.price === null || a.price === undefined || !Number.isFinite(n) ? 'na' : Math.round(n * 100);
  return `${a.kind}|${a.retailer}|${a.productKey}|${cents}`;
}

/** Split alerts into fresh ones and duplicates of a post inside the kind's window (or of another alert in this run). */
export function dedupe(alerts, ledger, now, cfg) {
  const fresh = [];
  const dupes = [];
  const seen = new Set();
  for (const a of alerts) {
    const k = idemKey(a);
    const w = (cfg.dedupe.windowMinutes[a.kind] ?? 60) * MIN;
    const prev = ledger[k];
    if (seen.has(k) || (prev && now - prev.at < w)) dupes.push({ alert: a, idem: k, prevAt: prev?.at ?? now });
    else {
      seen.add(k);
      fresh.push(a);
    }
  }
  return { fresh, dupes };
}

export function ledgerRecord(ledger, alert, now, status, channel = null) {
  ledger[idemKey(alert)] = { at: now, k: alert.key, s: status, ch: channel, m: null };
}

/** Mark ledger entries as sent, with the Telegram message id (for a later correction). */
export function ledgerMarkSent(ledger, sent = [], channel = null) {
  const byKey = new Map(Object.entries(ledger).map(([idem, e]) => [e.k, idem]));
  let n = 0;
  for (const s of sent) {
    const idem = byKey.get(s.key);
    if (!idem) continue;
    Object.assign(ledger[idem], { s: 'sent', m: s.messageId ?? null, ch: ledger[idem].ch ?? channel, sentAt: s.at ?? null });
    n++;
  }
  return n;
}

export function ledgerPrune(ledger, now, keepHours) {
  for (const [k, e] of Object.entries(ledger)) if (now - e.at > keepHours * 3600000) delete ledger[k];
  return ledger;
}

// ---------- held posts ----------

/** Add held alerts (newest wins per shop + product + kind), drop old ones, cap the list. */
export function holdAlerts(held, items, now, cfg) {
  const list = Array.isArray(held) ? [...held] : [];
  for (const { alert, reason } of items) {
    const id = `${alert.kind}|${alert.retailer}|${alert.productKey}`;
    const i = list.findIndex((h) => h.id === id);
    const row = { id, at: now, reason, alert };
    if (i >= 0) list[i] = row;
    else list.push(row);
  }
  return list.filter((h) => now - h.at <= cfg.held.keepHours * 3600000).slice(-cfg.held.max);
}

/** Held alerts that are still fresh enough to post (the bot refuses alerts older than staleAfterMs anyway). */
export function releasable(held, now, staleAfterMs = 3600000) {
  return (held ?? []).filter((h) => now - Date.parse(h.alert.detectedAt) <= staleAfterMs).map((h) => h.alert);
}
