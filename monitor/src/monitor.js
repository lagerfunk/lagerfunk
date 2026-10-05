// The engine: picks due watch items, fetches, parses into Checks, keeps price history and emits Alerts.
// Runtime neutral. Platform files (platform/node.js, platform/worker.js) supply fetch, store and timers.
import { adapterFor, retailerIdFor } from './adapters/index.js';
import { makeCheck, classifyFailure, isBlockError } from './check.js';
import { fetchText } from './fetcher.js';
import { createHealth, HEALTH_KEY } from './health.js';
import { historyKey, summarize, addObservation } from './history.js';
import { evaluate, stateKey, sellerOk } from './rules.js';
import { addBusinessDays, berlinDate, dayDiff, hash32, sleep as realSleep } from './util.js';
import { partition, summarize as summarizeProfile, proxyAllowed } from './profile.js';
import { createFeedReader } from './feeds/index.js';

export const ALERT_TTL_SEC = 7 * 86400;

function prepareItems(raw) {
  const list = Array.isArray(raw) ? raw : raw?.items ?? [];
  return list
    .filter((x) => x && x.url && x.productKey && x.enabled !== false)
    .map((x) => {
      const adapter = adapterFor(x);
      return { ...x, retailer: retailerIdFor(x, adapter), intervalSec: Number(x.intervalSec) || adapter.defaultIntervalSec || 60, _adapter: adapter };
    });
}

/**
 * Split a watchlist by profile. Items the profile switches off stay in `disabled` with `_disabledReason`; the watchlist
 * file itself is never edited. Active items carry `_source`: "scrape" (fetch the page) or "feed" (read the affiliate feed).
 * Without a profile everything is active and scraped, which is the behaviour before profiles existed.
 */
export function partitionWatchlist(raw, { profile = null, feedRetailers = new Set() } = {}) {
  const items = prepareItems(raw);
  if (!profile) return { active: items.map((it) => ({ ...it, _source: 'scrape' })), disabled: [] };
  return partition(items, profile, feedRetailers);
}

export function normalizeWatchlist(raw, opts = {}) {
  return partitionWatchlist(raw, opts).active;
}

/** Stateless due test: each item gets a stable phase inside its interval, so load spreads evenly without stored timers. */
export function isDue(item, nowMs, prevTickMs) {
  const I = Math.max(1, item.intervalSec) * 1000;
  const phase = hash32(`${item.retailer}:${item.productKey}:${item.url}`) % I;
  return Math.floor((nowMs + phase) / I) !== Math.floor((prevTickMs + phase) / I);
}

export function createMonitor({
  store,
  watchlist = [],
  fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
  proxy = null,
  proxyModes = {},
  options = {},
  now = () => Date.now(),
  log = console,
  onAlerts = null,
  concurrency = 6,
  jitterMs = 0,
  timeoutMs = 20000,
  sleep = realSleep,
  random = Math.random,
  healthFlushMs = 10 * 60000,
  defaultShipDays = 3,
  profile = null,
  feeds = null,
  feedTimeoutMs,
} = {}) {
  if (!store) throw new Error('createMonitor: store is required');
  // A profile that says proxy:"never" wins over anything passed in: no code path below may reach a proxy.
  if (!proxyAllowed(profile) && proxy) {
    log.warn?.(`profile "${profile.name}" forbids proxies: ignoring the configured proxy`);
    proxy = null;
  }
  const feedReader = feeds && typeof feeds.read === 'function' ? feeds : feeds && Object.keys(feeds).length ? createFeedReader({ feeds, fetch: fetchImpl, store, now, log, timeoutMs: feedTimeoutMs }) : null;
  let items = [];
  let disabled = [];
  const split = (raw) => {
    const r = partitionWatchlist(raw, { profile, feedRetailers: new Set(feedReader?.retailers() ?? []) });
    items = r.active;
    disabled = r.disabled;
  };
  split(watchlist);
  const health = createHealth({ random });
  const cache = new Map();
  let loaded = false;
  let lastHealthFlush = 0;
  let prevTick = null;

  async function cached(key) {
    if (cache.has(key)) return cache.get(key);
    const v = await store.get(key);
    cache.set(key, v);
    return v;
  }
  async function save(key, value, ttl) {
    cache.set(key, value);
    await store.put(key, value, ttl);
  }

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      health.load(await store.get(HEALTH_KEY));
    } catch (e) {
      log.warn?.(`health load failed: ${e.message}`);
    }
  }

  async function flushHealth(force = false) {
    const t = now();
    if (!force && !(health.dirty && t - lastHealthFlush >= healthFlushMs)) return;
    lastHealthFlush = t;
    health.clean();
    await store.put(HEALTH_KEY, health.snapshot(t));
  }

  function proxyFor(item, forceProxy) {
    if (!proxy) return null;
    const mode = proxyModes[item.retailer] ?? item.proxy ?? item._adapter.proxy ?? 'fallback';
    if (mode === 'never') return null;
    if (forceProxy || mode === 'always') return proxy;
    if (mode === 'fallback' && health.prefersProxy(item.retailer, now())) return proxy;
    return null;
  }

  async function fetchFor(item, req, forceProxy = false) {
    return fetchText(fetchImpl, req, { timeoutMs, proxy: proxyFor(item, forceProxy) });
  }

  /** Fetch and parse one item into a Check (no rules, no storage). */
  async function probe(item) {
    const adapter = item._adapter;
    const t = now();
    const ctxBase = { item, now: t };
    if (adapter.prepare) {
      try {
        await adapter.prepare(item, { ...ctxBase, fetchText: (req) => fetchFor(item, req) });
      } catch (e) {
        log.warn?.(`${item.retailer} prepare failed: ${e.message}`);
      }
    }
    const req = adapter.request(item);
    let res = await fetchFor(item, req);
    let parsed = parseSafe(adapter, res, item, t);
    // Fallback through the proxy when the direct request was blocked.
    if (!parsed.ok && isBlockError(parsed.error) && !res.viaProxy && proxy && (proxyModes[item.retailer] ?? item.proxy ?? adapter.proxy ?? 'fallback') === 'fallback') {
      health.record(item.retailer, { ok: false, error: parsed.error, httpStatus: res.status, bytes: res.bytes, viaProxy: false, at: t });
      const res2 = await fetchFor(item, req, true);
      const parsed2 = parseSafe(adapter, res2, item, t);
      if (parsed2.ok) health.stickToProxy(item.retailer, t);
      res = res2;
      parsed = parsed2;
    }
    const check = makeCheck({
      retailer: item.retailer,
      productKey: item.productKey,
      url: parsed.url ?? item.url,
      checkedAt: new Date(t).toISOString(),
      httpStatus: res.status,
      bytes: res.bytes,
      viaProxy: res.viaProxy,
      ...parsed,
      title: parsed.title ?? item.title ?? null,
    });
    normalizeDelivery(check, t, defaultShipDays);
    return check;
  }

  /** Full cycle for one item: probe, then process the Check. */
  async function checkItem(item) {
    return processCheck(item, await probe(item));
  }

  /** Health, history, rules and storage for a Check that came from any source (page or feed). */
  async function processCheck(item, check) {
    const t = Date.parse(check.checkedAt);
    const statusChange = health.record(item.retailer, { ok: check.ok, error: check.error, httpStatus: check.httpStatus, bytes: check.bytes, viaProxy: check.viaProxy, at: t });
    if (statusChange) {
      log.warn?.(`[health] ${item.retailer} is now ${statusChange} (${check.error ?? 'ok'})`);
      await flushHealth(true);
    }

    const hKey = historyKey(item.retailer, item.productKey);
    const sKey = stateKey(item.retailer, item.productKey);
    const [histRaw, prev] = await Promise.all([cached(hKey), cached(sKey)]);
    const hist = histRaw ? summarize(histRaw, t) : null;
    const { alert, state, changed, flags } = evaluate({ item, check, prev, hist, adapter: item._adapter, now: t, options });

    // History starts at the very first check, even when sold out, so 30 days of coverage accrue from deployment.
    if (check.ok || !histRaw) {
      const countable = check.ok && check.inStock === true && check.price !== null && sellerOk(check, item._adapter);
      const { hist: next, changed: hChanged } = addObservation(histRaw ? structuredClone(histRaw) : null, t, { price: check.price, countable });
      if (hChanged) await save(hKey, next);
    }
    if (changed) await save(sKey, state);
    if (alert) await store.put(`alert:${alert.key}`, alert, ALERT_TTL_SEC);
    return { check, alert, flags };
  }

  async function runItems(list) {
    list = list.filter((it) => it._source !== 'feed');
    const checks = [];
    const alerts = [];
    const byRetailer = new Map();
    for (const it of list) {
      if (!byRetailer.has(it.retailer)) byRetailer.set(it.retailer, []);
      byRetailer.get(it.retailer).push(it);
    }
    const lanes = [...byRetailer.values()];
    let idx = 0;
    async function worker() {
      while (idx < lanes.length) {
        const lane = lanes[idx++];
        for (const it of lane) {
          if (jitterMs > 0) await sleep(Math.floor(random() * jitterMs));
          if (health.isPaused(it.retailer, now())) continue;
          try {
            const r = await checkItem(it);
            checks.push(r.check);
            if (r.alert) alerts.push(r.alert);
          } catch (e) {
            log.error?.(`check ${it.retailer}/${it.productKey} crashed: ${e.stack ?? e}`);
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, lanes.length || 1) }, worker));
    await flushHealth(false);
    if (alerts.length && onAlerts) await onAlerts(alerts);
    return { checks, alerts };
  }

  /**
   * Read the feeds of every retailer whose items are fed (all of them, or only `only`, or those `due` says yes to).
   * One download per retailer. Returns Checks and Alerts like runItems, plus one summary per feed.
   */
  async function runFeeds({ only = null, force = false, due = null } = {}) {
    const out = { checks: [], alerts: [], feeds: [] };
    if (!feedReader) return out;
    await ensureLoaded();
    const byRetailer = new Map();
    for (const it of items) {
      if (it._source !== 'feed') continue;
      if (only && !only.includes(it.retailer)) continue;
      if (due && !due(it.retailer)) continue;
      if (!byRetailer.has(it.retailer)) byRetailer.set(it.retailer, []);
      byRetailer.get(it.retailer).push(it);
    }
    for (const [retailer, list] of byRetailer) {
      if (health.isPaused(retailer, now())) {
        out.feeds.push({ retailer, status: 'skipped', reason: 'paused', rows: 0, matched: 0, bytes: 0, ms: 0, items: list.length });
        continue;
      }
      let res;
      try {
        res = await feedReader.read(retailer, list, { force });
      } catch (e) {
        log.error?.(`feed ${retailer} crashed: ${e.stack ?? e}`);
        out.feeds.push({ retailer, status: 'error', reason: 'feed:crash', rows: 0, matched: 0, bytes: 0, ms: 0, items: list.length });
        continue;
      }
      const { checks: pairs, ...summary } = res;
      out.feeds.push({ ...summary, items: list.length });
      for (const { item, check } of pairs) {
        normalizeDelivery(check, Date.parse(check.checkedAt), defaultShipDays);
        try {
          const r = await processCheck(item, check);
          out.checks.push(r.check);
          if (r.alert) out.alerts.push(r.alert);
        } catch (e) {
          log.error?.(`feed check ${item.retailer}/${item.productKey} crashed: ${e.stack ?? e}`);
        }
      }
    }
    await flushHealth(false);
    if (out.alerts.length && onAlerts) await onAlerts(out.alerts);
    return out;
  }

  const merge = (a, b) => ({ checks: [...a.checks, ...b.checks], alerts: [...a.alerts, ...b.alerts], feeds: b.feeds ?? a.feeds ?? [] });

  return {
    get items() {
      return items;
    },
    get disabledItems() {
      return disabled;
    },
    get profile() {
      return profile;
    },
    setWatchlist(raw) {
      split(raw);
    },
    /**
     * Run the items whose interval slot started since the last tick, and the feeds whose slot started.
     * `since` (ms, e.g. the time of the previous run read from the store) replaces the remembered last tick, so a
     * short-lived process such as a scheduled job misses no slot even when its schedule runs late.
     * `source` "scrape" or "feed" limits the tick to one kind of item.
     */
    async tick({ tickMs = 60000, since = null, source = null } = {}) {
      await ensureLoaded();
      const t = now();
      const prevT = Number.isFinite(since) && since < t ? since : prevTick ?? t - tickMs;
      prevTick = t;
      const due = items.filter((it) => isDue(it, t, prevT) && !health.isPaused(it.retailer, t));
      const scraped = source === 'feed' ? { checks: [], alerts: [] } : await runItems(due);
      if (!feedReader || source === 'scrape') return scraped;
      const fed = await runFeeds({
        due: (retailer) => isDue({ retailer, productKey: 'feed', url: `feed:${retailer}`, intervalSec: feedReader.config(retailer)?.intervalSec ?? 3600 }, t, prevT),
      });
      return merge(scraped, fed);
    },
    /** Check every item once, ignoring intervals (CLI --once). source: "scrape" | "feed" | omitted for both. */
    async runAll({ source = null, force = false } = {}) {
      await ensureLoaded();
      let out = { checks: [], alerts: [], feeds: [] };
      if (source !== 'feed') out = merge(out, await runItems(items.filter((it) => !health.isPaused(it.retailer, now()))));
      if (source !== 'scrape' && feedReader) out = merge(out, await runFeeds({ force }));
      return out;
    },
    runFeeds,
    /** Process a Check produced elsewhere (tests, other adapters) exactly like a scraped one. */
    ingestCheck: processCheck,
    checkItem,
    probe,
    health: () => health.snapshot(now()),
    /** What is on, from where, and why the rest is off. */
    status() {
      return {
        profile: profile ? { name: profile.name, proxy: profile.proxy, description: profile.description } : null,
        proxy: proxy ? 'configured' : 'none',
        retailers: summarizeProfile(items, disabled),
        active: items.length,
        disabled: disabled.length,
        feeds: feedReader ? feedReader.describe() : [],
      };
    },
    flush: () => flushHealth(true),
  };
}

function parseSafe(adapter, res, item, t) {
  if (res.error && !res.text) return { ok: false, error: res.error };
  if (res.status === 404 || res.status === 410) return { ok: false, error: classifyFailure(res.status, res.text) ?? 'not_found' };
  let parsed;
  try {
    parsed = adapter.parse(res.text, { item, now: t, status: res.status, url: res.url });
  } catch (e) {
    parsed = { ok: false, error: `parse:${e.message}` };
  }
  if (!parsed.ok) {
    const cls = classifyFailure(res.status, res.text);
    if (cls && (parsed.error === 'parse:no_offer' || String(parsed.error).startsWith('parse:'))) parsed.error = cls;
    else if (!parsed.error) parsed.error = cls ?? 'parse:no_offer';
  } else if (res.status && res.status >= 400) {
    parsed = { ok: false, error: classifyFailure(res.status, res.text) ?? `http_${res.status}` };
  }
  return parsed;
}

/** Fill a default delivery date for plain in-stock offers and flag far-out deliveries as back-orders. */
export function normalizeDelivery(check, t, defaultShipDays = 3) {
  if (!check.ok || check.inStock !== true) return check;
  if (!check.deliveryEstimate && !check.isPreorder && !check.isBackorder) {
    check.deliveryEstimate = addBusinessDays(t, defaultShipDays);
    check.deliveryAssumed = true;
  }
  if (check.deliveryEstimate && !check.isPreorder && dayDiff(berlinDate(t), check.deliveryEstimate) > 14) check.isBackorder = true;
  return check;
}
