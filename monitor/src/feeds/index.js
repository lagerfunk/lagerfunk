// Affiliate product feeds as a data source for the monitor: Awin (CSV, JSON Lines) and Tradedoubler (XML, JSON).
// A feed is read as a stream (never held in memory), only rows that match a watch item are kept, and each match is
// turned into the same Check object a scraped page produces. Runtime neutral: only fetch and the store are injected.
//
// Safety rules (a wrong feed must never look like a restock):
//   * a download that fails, is cut off, has the wrong columns, or is far smaller than last time gives ok:false Checks
//     (stock state untouched), never "sold out";
//   * a product that is missing from a healthy feed counts as sold out only when it was in the feed before; one that
//     was never found reports feed:not_listed so a bad URL or id is visible instead of silent;
//   * feed URLs hold API keys: they come from env, are redacted from every message, and are never stored.
import config from '../../config/feeds.json' with { type: 'json' };
import { makeCheck } from '../check.js';
import { berlinDate, hostOf } from '../util.js';
import { textChunks, charsetOf } from './stream.js';
import { canonUrl, productIdFromUrl, normId, normGtin, targetOfTracking } from './common.js';
import { FORMATS as AWIN_FORMATS, awinFeedUrl } from './awin.js';
import { FORMATS as TD_FORMATS, lastUpdatedUrl, ensureSourceUrl, TD_DAILY_DOWNLOADS } from './tradedoubler.js';

export const FEED_FORMATS = { ...AWIN_FORMATS, ...TD_FORMATS };
export const FEED_FORMAT_NAMES = Object.keys(FEED_FORMATS);
export const feedMetaKey = (retailer) => `feedmeta:${retailer}`;
export { awinFeedUrl, TD_DAILY_DOWNLOADS };

/** Pick the format from the URL, unless the config names one. */
export function detectFormat(url, hint = null) {
  if (hint) {
    if (!FEED_FORMATS[hint]) throw new Error(`unknown feed format "${hint}". Available: ${FEED_FORMAT_NAMES.join(', ')}`);
    return hint;
  }
  const host = hostOf(url);
  if (host.endsWith('tradedoubler.com')) return /productsUnlimited\.json|\.json[;?]|format=json/i.test(url) ? 'td-json' : 'td-xml';
  if (host === 'api.awin.com' || /\.jsonl(\?|$)/i.test(url)) return 'awin-jsonl';
  return 'awin-csv';
}

const idOf = (retailer) => String(retailer).toUpperCase().replace(/[^A-Z0-9]/g, '_');

/**
 * Feeds that are switched on by environment variables.
 *   FEED_URL_<RETAILER>      full download URL (Awin Create-a-Feed link, Awin awinfeeds link, Tradedoubler productsUnlimited link)
 *   FEED_FORMAT_<RETAILER>   optional: awin-csv | awin-jsonl | td-xml | td-json (otherwise detected from the URL)
 *   AWIN_API_TOKEN           bearer token for awin-jsonl downloads
 *   AWIN_PUBLISHER_ID        with FEED_FORMAT_<R>=awin-jsonl and no URL, the awinfeeds URL is built from the advertiser id
 *                            in config/feeds.json (or FEED_ADVERTISER_<R>)
 * Returns { [retailerId]: FeedConfig }. Retailers without a URL are simply absent: their items stay disabled in the profile.
 */
export function feedsFromEnv(env = {}, cfg = config) {
  const out = {};
  const known = Object.keys(cfg.feeds ?? {});
  const fromEnv = Object.keys(env).map((k) => /^FEED_URL_([A-Z0-9_]+)$/.exec(k)?.[1]).filter(Boolean).map((s) => s.toLowerCase());
  const secrets = [env.AWIN_API_TOKEN].filter(Boolean);
  for (const retailer of new Set([...known, ...fromEnv])) {
    const id = idOf(retailer);
    const meta = cfg.feeds?.[retailer] ?? {};
    const hint = env[`FEED_FORMAT_${id}`] || meta.format || null;
    let url = env[`FEED_URL_${id}`]?.trim() || null;
    if (!url && hint === 'awin-jsonl' && env.AWIN_PUBLISHER_ID) {
      const adv = env[`FEED_ADVERTISER_${id}`] || meta.advertiserId;
      if (adv) url = `https://api.awin.com/publishers/${encodeURIComponent(env.AWIN_PUBLISHER_ID)}/awinfeeds/download/${encodeURIComponent(adv)}-retail-de_DE.jsonl`;
    }
    if (!url) continue;
    const format = detectFormat(url, hint);
    if (format.startsWith('td-')) url = ensureSourceUrl(url);
    const d = cfg.defaults ?? {};
    out[retailer] = {
      retailer,
      name: meta.name ?? retailer,
      network: format.startsWith('td-') ? 'tradedoubler' : 'awin',
      format,
      url,
      headers: format === 'awin-jsonl' && env.AWIN_API_TOKEN ? { authorization: `Bearer ${env.AWIN_API_TOKEN}` } : {},
      intervalSec: Number(meta.intervalSec ?? d.intervalSec ?? 3600),
      minIntervalSec: Number(meta.minIntervalSec ?? d.minIntervalSec ?? 1800),
      timeoutSec: Number(meta.timeoutSec ?? d.timeoutSec ?? 600),
      maxBytes: Number(meta.maxBytes ?? d.maxBytes ?? 1.5e9),
      minRowsRatio: Number(meta.minRowsRatio ?? d.minRowsRatio ?? 0.5),
      secrets: [...secrets, ...secretsInUrl(url)],
    };
  }
  return out;
}

function secretsInUrl(url) {
  const found = [];
  for (const re of [/apikey\/([^/]+)/i, /[?&;]token=([^&\s]+)/i, /[?&;]apikey=([^&\s]+)/i]) {
    const m = re.exec(url);
    if (m) found.push(m[1]);
  }
  return found;
}

/** Remove API keys and tokens from any text before it is logged, stored or posted. */
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const sec of secrets) if (sec && sec.length >= 4) s = s.split(sec).join('***');
  return s
    .replace(/(apikey\/)[^/\s"']+/gi, '$1***')
    .replace(/([?&;](?:token|apikey|api_key|key)=)[^&\s"']+/gi, '$1***')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***');
}

// ---------- matching ----------

const USED = /used|gebraucht|refurb|aufbereitet|b-?ware|open[ _-]?box|renewed/i;

/** Keys a watch item can be found by, strongest first: [key, priority]. */
export function itemKeys(item) {
  const out = [];
  const f = item.feed ?? {};
  for (const v of [f.ean, item.ean, item.gtin]) {
    const g = normGtin(v);
    if (g) out.push([`ean:${g}`, 4]);
  }
  for (const v of [f.id, item.sku]) {
    const n = normId(v);
    if (n) out.push([`id:${n}`, 3]);
  }
  const fromUrl = productIdFromUrl(item.url);
  if (fromUrl) out.push([`id:${fromUrl}`, 3]);
  for (const u of [item.url, f.url]) {
    const c = u ? canonUrl(u) : null;
    if (c) out.push([`url:${c}`, 2]);
  }
  for (const v of [f.mpn, item.mpn, item.sku]) {
    const n = normId(v);
    if (n) out.push([`mpn:${n}`, 1]);
  }
  return out;
}

/** Keys an offer can be found by (same shape as itemKeys). */
export function offerKeys(offer) {
  const out = [];
  if (offer.ids.ean) out.push([`ean:${offer.ids.ean}`, 4]);
  for (const v of [offer.ids.merchant, offer.ids.awin]) if (v) out.push([`id:${v}`, 3]);
  const target = offer.url ?? (offer.trackingUrl ? targetOfTracking(offer.trackingUrl) : null);
  if (target) {
    const fromUrl = productIdFromUrl(target);
    if (fromUrl) out.push([`id:${fromUrl}`, 3]);
    const c = canonUrl(target);
    if (c) out.push([`url:${c}`, 2]);
  }
  if (offer.ids.mpn) out.push([`mpn:${offer.ids.mpn}`, 1]);
  return out;
}

const rank = (c) => [c.priority, c.offer.inStock ? 1 : 0, -(c.offer.price ?? Infinity)];
function better(a, b) {
  const x = rank(a);
  const y = rank(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * Read a stream of feed rows and keep the best matching offer per watch item.
 * @param {AsyncIterable<object>} rows   output of a format's rows()
 * @param {(row, ctx) => object|null} offerFn  the format's offer()
 * @returns {Promise<{rows:number, bad:number, best:Map<number,{offer:object, priority:number}>}>}
 */
export async function collectOffers(rows, offerFn, items, { now = Date.now(), feed = {} } = {}) {
  const want = new Map();
  items.forEach((it, idx) => {
    for (const [k, p] of itemKeys(it)) {
      if (!want.has(k)) want.set(k, []);
      want.get(k).push({ idx, p });
    }
  });
  const best = new Map();
  let count = 0;
  let bad = 0;
  for await (const row of rows) {
    count++;
    let offer;
    try {
      offer = offerFn(row, { now, feed });
    } catch {
      bad++;
      continue;
    }
    if (!offer) {
      bad++;
      continue;
    }
    for (const [k] of offerKeys(offer)) {
      const hits = want.get(k);
      if (!hits) continue;
      for (const { idx, p } of hits) {
        if (offer.condition && USED.test(offer.condition) && !items[idx].allowUsed) continue;
        const cand = { offer, priority: p };
        const cur = best.get(idx);
        if (!cur || better(cand, cur)) best.set(idx, cand);
      }
    }
  }
  return { rows: count, bad, best };
}

// ---------- offer -> Check ----------

/** One matched offer as a Check. The URL is the tracking link when the feed has one, so the bot labels the post "Anzeige". */
export function offerToCheck(item, offer, { now = Date.now(), feed = {}, bytes = 0 } = {}) {
  const base = {
    retailer: item.retailer,
    productKey: item.productKey,
    url: offer.trackingUrl ?? offer.url ?? item.url,
    title: offer.title ?? item.title ?? null,
    checkedAt: new Date(now).toISOString(),
    httpStatus: 200,
    bytes,
    soldBy: offer.seller ?? feed.name ?? item.retailer,
    soldByRetailer: true,
    imageUrl: offer.imageUrl ?? null,
  };
  if (offer.currency && offer.currency !== 'EUR') return makeCheck({ ...base, ok: false, error: `feed:currency:${offer.currency}`, httpStatus: 200 });
  const inStock = offer.inStock === true;
  if (inStock && offer.price === null) return makeCheck({ ...base, ok: false, error: 'feed:no_price' });
  return makeCheck({
    ...base,
    ok: true,
    inStock,
    price: offer.price,
    stockText: offer.stockText ?? null,
    isPreorder: Boolean(offer.isPreorder && inStock),
    isBackorder: Boolean(offer.isBackorder && inStock),
    deliveryEstimate: inStock ? offer.deliveryEstimate ?? null : null,
  });
}

function failCheck(item, error, { now, bytes = 0, httpStatus = null }) {
  return makeCheck({ retailer: item.retailer, productKey: item.productKey, url: item.url, title: item.title ?? null, checkedAt: new Date(now).toISOString(), ok: false, error, httpStatus, bytes });
}

function soldOutCheck(item, { now, feed }) {
  return makeCheck({
    retailer: item.retailer,
    productKey: item.productKey,
    url: item.url,
    title: item.title ?? null,
    checkedAt: new Date(now).toISOString(),
    ok: true,
    inStock: false,
    price: null,
    httpStatus: 200,
    soldBy: feed.name ?? item.retailer,
    soldByRetailer: true,
    stockText: 'nicht mehr im Feed',
  });
}

// ---------- download ----------

/** Short, redacted error code for anything thrown while reading a feed. */
export function feedErrorCode(e, secrets = []) {
  // zlib errors from DecompressionStream carry an empty message and the detail in code and cause
  const msg = [e?.message ?? (typeof e === 'string' ? e : ''), e?.code, e?.cause?.message, e?.cause?.code].filter(Boolean).join(' ');
  if (e?.name === 'AbortError' || /timeout/i.test(msg)) return 'timeout';
  if (/^feed:/.test(msg)) return redact(msg, secrets).slice(0, 120);
  if (/unexpected end|incorrect header|invalid (?:stored|distance|code|block)|premature close|z_data_error|z_buf_error|inflate/i.test(msg)) return 'feed:corrupt_download';
  return redact(`feed:read:${msg}`, secrets).slice(0, 120);
}

function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'feed:auth';
  if (status === 404 || status === 410) return 'feed:not_found';
  if (status === 429) return 'feed:rate_limited';
  if (status >= 500) return `feed:http_${status}`;
  return `feed:http_${status}`;
}

/**
 * Reads feeds for the monitor. One download per retailer per run, shared by all that retailer's watch items.
 * Persists a small meta document per feed (row count, validators, Tradedoubler quota) under feedmeta:<retailer>.
 */
export function createFeedReader({ feeds = {}, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), store, now = () => Date.now(), log = console } = {}) {
  if (!store) throw new Error('createFeedReader: store is required');

  const redactFor = (feed, text) => redact(text, feed.secrets);

  async function readMeta(retailer) {
    return (await store.get(feedMetaKey(retailer))) ?? {};
  }

  async function request(feed, url, { headers = {}, timeoutMs }) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
    try {
      const aborted = new Promise((_, rej) => ac.signal.addEventListener('abort', () => rej(Object.assign(new Error('timeout'), { name: 'AbortError' })), { once: true }));
      const res = await Promise.race([fetchImpl(url, { method: 'GET', headers: { 'user-agent': 'lagerfunk-feed-reader/1.0', ...feed.headers, ...headers }, redirect: 'follow', signal: ac.signal }), aborted]);
      return { res, done: () => clearTimeout(timer) };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  /** Tradedoubler: has the feed changed since our last download? Returns {changed, time}. Failures mean "unknown". */
  async function tdChanged(feed, meta) {
    const url = lastUpdatedUrl(feed.url);
    if (!url) return { changed: true, time: null };
    try {
      const { res, done } = await request(feed, url, { timeoutMs: 30000 });
      try {
        if (!res.ok) return { changed: true, time: null };
        const body = await res.json();
        const time = body?.lastUpdatedTime ?? null;
        return { changed: !time || time !== meta.tdLastUpdated, time };
      } finally {
        done();
      }
    } catch {
      return { changed: true, time: null };
    }
  }

  /**
   * @param {string} retailer
   * @param {object[]} items  active watch items of this retailer (monitor-normalized)
   * @param {{force?:boolean}} opts
   * @returns {Promise<{retailer, status:'ok'|'skipped'|'error', reason:string|null, rows:number, matched:number, bytes:number, ms:number, checks:{item,check}[]}>}
   */
  async function read(retailer, items, { force = false } = {}) {
    const feed = feeds[retailer];
    const t0 = now();
    const out = { retailer, status: 'ok', reason: null, rows: 0, matched: 0, bytes: 0, ms: 0, format: feed?.format ?? null, checks: [] };
    const finish = (extra) => Object.assign(out, extra, { ms: now() - t0 });
    const failAll = (code, extra = {}) => finish({ status: 'error', reason: code, checks: items.map((item) => ({ item, check: failCheck(item, code, { now: t0, httpStatus: extra.httpStatus ?? null }) })) });
    if (!feed) return failAll('feed:not_configured');

    const meta = await readMeta(retailer);
    const dayAgo = t0 - 86400000;

    // 1. Do we need to download at all?
    if (!force && meta.fetchedAt && t0 - meta.fetchedAt < feed.minIntervalSec * 1000) {
      return finish({ status: 'skipped', reason: 'fresh' });
    }
    let tdTime = null;
    if (feed.network === 'tradedoubler') {
      const recent = (meta.tdDownloads ?? []).filter((x) => x > dayAgo);
      if (recent.length >= TD_DAILY_DOWNLOADS) return finish({ status: 'skipped', reason: `quota:${recent.length}/${TD_DAILY_DOWNLOADS} downloads in 24h` });
      const lu = await tdChanged(feed, meta);
      tdTime = lu.time;
      if (!force && !lu.changed) {
        await store.put(feedMetaKey(retailer), { ...meta, checkedAt: t0, tdDownloads: recent });
        return finish({ status: 'skipped', reason: 'unchanged' });
      }
      meta.tdDownloads = [...recent, t0]; // count the attempt, a failed download may count against the quota too
    }

    // 2. Download and stream
    const condHeaders = {};
    if (feed.network !== 'tradedoubler') {
      if (meta.etag) condHeaders['if-none-match'] = meta.etag;
      else if (meta.lastModified) condHeaders['if-modified-since'] = meta.lastModified;
    }
    let result;
    let bytes = 0;
    let handle = null;
    try {
      handle = await request(feed, feed.url, { headers: condHeaders, timeoutMs: feed.timeoutSec * 1000 });
      const { res } = handle;
      if (res.status === 304) {
        await store.put(feedMetaKey(retailer), { ...meta, fetchedAt: t0 });
        return finish({ status: 'skipped', reason: 'not_modified' });
      }
      if (!res.ok) {
        await store.put(feedMetaKey(retailer), { ...meta, lastError: httpErrorCode(res.status), lastErrorAt: t0 });
        return failAll(httpErrorCode(res.status), { httpStatus: res.status });
      }
      const fmt = FEED_FORMATS[feed.format];
      const counted = countBytes(res);
      const chunks = textChunks(counted.source, { maxBytes: feed.maxBytes, charset: charsetOf(res.headers?.get?.('content-type') ?? '') });
      result = await collectOffers(fmt.rows(chunks), fmt.offer, items, { now: t0, feed });
      bytes = counted.bytes();
      meta.etag = res.headers?.get?.('etag') ?? null;
      meta.lastModified = res.headers?.get?.('last-modified') ?? null;
    } catch (e) {
      const code = feedErrorCode(e, feed.secrets);
      log.warn?.(`[feed] ${retailer}: ${code}`);
      await store.put(feedMetaKey(retailer), { ...meta, lastError: code, lastErrorAt: t0 });
      return failAll(code);
    } finally {
      handle?.done();
    }
    out.rows = result.rows;
    out.bytes = bytes;

    // 3. Is this a believable feed?
    if (result.rows === 0) return failAll('feed:empty');
    if (result.bad / result.rows > 0.05) return failAll(`feed:bad_rows:${result.bad}/${result.rows}`);
    if (meta.rows && result.rows < meta.rows * feed.minRowsRatio) {
      const stable = meta.shrunkRows && Math.abs(result.rows - meta.shrunkRows) <= Math.max(5, meta.shrunkRows * 0.02);
      if (!stable) {
        await store.put(feedMetaKey(retailer), { ...meta, shrunkRows: result.rows, lastError: 'feed:shrunk', lastErrorAt: t0 });
        log.warn?.(`[feed] ${retailer}: ${result.rows} rows against ${meta.rows} last time, waiting for a second run to confirm`);
        return failAll(`feed:shrunk:${result.rows}/${meta.rows}`);
      }
    }

    // 4. Map to Checks
    const seen = { ...(meta.seen ?? {}) };
    const today = berlinDate(t0);
    let first = true;
    items.forEach((item, idx) => {
      const hit = result.best.get(idx);
      let check;
      if (hit) {
        check = offerToCheck(item, hit.offer, { now: t0, feed });
        if (check.ok) seen[item.productKey] = today;
        out.matched++;
      } else if (seen[item.productKey]) {
        check = soldOutCheck(item, { now: t0, feed });
      } else {
        check = failCheck(item, 'feed:not_listed', { now: t0, httpStatus: 200 });
      }
      if (first) {
        check.bytes = bytes;
        first = false;
      }
      out.checks.push({ item, check });
    });
    for (const k of Object.keys(seen)) if (!items.some((i) => i.productKey === k)) delete seen[k];

    await store.put(feedMetaKey(retailer), {
      fetchedAt: t0,
      rows: result.rows,
      bytes,
      matched: out.matched,
      items: items.length,
      etag: meta.etag ?? null,
      lastModified: meta.lastModified ?? null,
      tdLastUpdated: tdTime ?? meta.tdLastUpdated ?? null,
      tdDownloads: meta.tdDownloads,
      seen,
      lastError: null,
    });
    return finish({});
  }

  return {
    has: (retailer) => Boolean(feeds[retailer]),
    retailers: () => Object.keys(feeds),
    config: (retailer) => feeds[retailer] ?? null,
    describe: () => Object.values(feeds).map((f) => ({ retailer: f.retailer, name: f.name, network: f.network, format: f.format, url: redactFor(f, f.url) })),
    read,
  };
}

/** Wrap a Response so that downloaded bytes are counted while textChunks reads it. */
function countBytes(res) {
  let n = 0;
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') return { source: res, bytes: () => n };
  const reader = body.getReader();
  const source = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else {
        n += value.byteLength;
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { source, bytes: () => n };
}
