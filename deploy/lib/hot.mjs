// Hot watcher: the NVIDIA Founders Edition every 10 s and ALTERNATE's RTX 50 listings about once every 10 s in total,
// with a retail-price check and a log of every stock drop. Alerts go to the owner's private admin chat only.
//
// A DROP is a card that can be ordered at or under its model's buyBelow (default: NVIDIA's UVP + tolerancePct). The log
// (deploy/config/hot.json "models", saved as drops.json on the 'drops' branch) keeps when each drop started and ended, so
// every alert can say when the last one was. Each source runs on its own timer; one slow shop never delays the FE check.
// It never logs in, never fills a cart and never orders: buying stays a human tap.
import { adapterById } from '../../monitor/src/adapters/index.js';
import { BROWSER_HEADERS } from '../../monitor/src/adapters/common.js';
import { fetchText } from '../../monitor/src/fetcher.js';
import { classifyFailure } from '../../monitor/src/check.js';
import { parseEuro, cleanText } from '../../monitor/src/util.js';

export const HOT_CONFIG_FILE = 'deploy/config/hot.json';
export const MIN_EVERY_SEC = 10; // politeness floor per source, whatever the config says
export const KEEP_DROPS = 500;
export const MISSING_CLOSE_MIN = 30; // an open drop whose card vanished from the listing is closed after this long

// ---------- config ----------

export function normalizeHot(raw) {
  const tol = Number(raw?.tolerancePct ?? 10);
  const models = {};
  for (const [id, m] of Object.entries(raw?.models ?? {})) {
    const uvp = m.uvp == null ? null : Number(m.uvp);
    models[id] = {
      id,
      label: m.label ?? id,
      uvp,
      buyBelow: m.buyBelow != null ? Number(m.buyBelow) : uvp != null ? Math.round(uvp * (1 + tol / 100) * 100) / 100 : null,
      alert: m.alert !== false,
      dipPct: m.dipPct == null ? null : Number(m.dipPct), // also a drop: this much under the recent market low
      floorDays: Math.max(3, Number(m.floorDays) || 14),
      floorSeed: m.floorSeed ?? {},
    };
  }
  const sources = (raw?.sources ?? [])
    .filter((s) => s && s.id && s.type && s.enabled !== false)
    .map((s) => ({ ...s, everySec: Math.max(MIN_EVERY_SEC, Number(s.everySec) || 60), items: s.items ?? [] }));
  return {
    loopMinutes: Math.min(55, Math.max(1, Number(raw?.loopMinutes) || 50)),
    remindMinutes: Math.max(5, Number(raw?.remindMinutes) || 15),
    failAlertAfter: Math.max(3, Number(raw?.failAlertAfter) || 20),
    saveEverySec: Math.max(15, Number(raw?.saveEverySec) || 60),
    tolerancePct: tol,
    models,
    trackingSince: raw?.trackingSince ?? {},
    pastDrops: Array.isArray(raw?.pastDrops) ? raw.pastDrops : [],
    sources,
  };
}

// ---------- parsing ----------

const STOCK_YES = /sofort verf(ü|ue)gbar|auf lager|lagernd|versandfertig|lieferung in \d/i;
const STOCK_NO = /nicht gekauft werden|nicht verf(ü|ue)gbar|ausverkauft|vorbestell|bestellartikel|nicht lieferbar|demn(ä|ae)chst/i;

/** Product tiles of an ALTERNATE category listing (server HTML). */
export function parseAlternateListing(html, model) {
  const text = String(html ?? '');
  const re = /<a href="([^"]*\/html\/product\/(\d+))" class="card align-content-center productBox/g;
  const starts = [...text.matchAll(re)];
  const out = [];
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1].index : Math.min(text.length, m.index + 20000);
    const tile = text.slice(m.index, end);
    const name = cleanText((tile.match(/class="product-name[^"]*">([\s\S]*?)<\/div>/) ?? [])[1]?.replace(/<[^>]+>/g, ' ') ?? '');
    const price = parseEuro((tile.match(/<span class="price[^"]*">\s*([^<]+)</) ?? [])[1] ?? null);
    const stockText = cleanText((tile.match(/delivery-info[^>]*>\s*<span[^>]*>([^<]*)</) ?? [])[1] ?? '') || null;
    const inStock = stockText ? STOCK_YES.test(stockText) && !STOCK_NO.test(stockText) : false;
    out.push({ key: `alternate:${m[2]}`, retailer: 'alternate', shop: 'ALTERNATE', model, title: name.replace(/,\s*Grafikkarte$/i, '') || null, url: m[1], price, inStock, stockText });
  }
  return out;
}

const MF_NOT_A_CARD = /^(PC|Gaming[- ]?PC|Notebook|Laptop)\b|alphacool|\bEK[- ]|water ?blocks?|watercool|heatkiller|bitspower|grizzly|wasserk|k(ü|ue|\S)hler|backplate|halterung|kabel|adapter|\bblock\b/i;

/**
 * Graphics cards from a Mindfactory search result page (server HTML, Latin-1 read as UTF-8, so umlauts may be garbled:
 * the patterns allow for that). Only real cards of the model pass: no PCs, notebooks, water blocks or accessories.
 * Returns { tiles, products }: tiles counts every result, so an empty card list on a real page is not a failure.
 */
export function parseMindfactorySearch(html, model, cardPattern) {
  const blocks = String(html ?? '').split(/<div class="p">/).slice(1);
  const want = new RegExp(cardPattern ?? 'RTX\\s?5090', 'i');
  const products = [];
  let tiles = 0;
  for (const b of blocks) {
    const name = cleanText((b.match(/<div class="pname">([\s\S]*?)<\/div>/) ?? [])[1] ?? '');
    if (!name) continue;
    tiles++;
    if (!want.test(name) || MF_NOT_A_CARD.test(name)) continue;
    const link = b.match(/href="(https:\/\/www\.mindfactory\.de\/product_info\.php\/(?:search\/true\/)?([^"]*?)_(\d+)\.html)"/);
    if (!link) continue;
    const rawPrice = ((b.match(/<div class="pprice">([\s\S]*?)<\/div>/) ?? [])[1] ?? '').replace(/<[^>]+>|&nbsp;|&euro;|\*/g, ' ').replace(/,-/, ',00');
    const stockText = cleanText(((b.match(/<div class="pshipping[^"]*">\s*<span[^>]*>([\s\S]*?)<\/span>/) ?? [])[1] ?? '').replace(/<[^>]+>/g, ' ')) || null;
    const inStock = Boolean(stockText) && /lagernd|verf\S{0,2}gbar/i.test(stockText) && !/nicht|\bab\b|bestellt|\d{2}\.\d{2}\./i.test(stockText);
    products.push({ key: `mindfactory:${link[3]}`, retailer: 'mindfactory', shop: 'Mindfactory', model, title: name, url: `https://www.mindfactory.de/product_info.php/${link[2]}_${link[3]}.html`, price: parseEuro(rawPrice), inStock, stockText });
  }
  return { tiles, products };
}

/** One fetch of one source. Never throws. Returns { ok, products } or { ok: false, error }. */
export async function fetchSource(src, { fetch: fetchImpl, now = () => Date.now() }) {
  if (src.type === 'alternate-listing') {
    const res = await fetchText(fetchImpl, { url: src.url, headers: BROWSER_HEADERS }, { timeoutMs: 15000 });
    if (res.error) return { ok: false, error: res.error };
    const products = parseAlternateListing(res.text, src.model);
    if (!products.length) return { ok: false, error: classifyFailure(res.status, res.text) ?? `parse:no_tiles (${res.status})` };
    return { ok: true, products };
  }
  if (src.type === 'mindfactory-search') {
    const res = await fetchText(fetchImpl, { url: src.url, headers: BROWSER_HEADERS }, { timeoutMs: 15000 });
    if (res.error) return { ok: false, error: res.error };
    const { tiles, products } = parseMindfactorySearch(res.text, src.model, src.cardPattern);
    if (!tiles) return { ok: false, error: classifyFailure(res.status, res.text) ?? `parse:no_tiles (${res.status})` };
    return { ok: true, products };
  }
  if (src.type === 'nvidia') {
    const adapter = adapterById('nvidia');
    const products = [];
    let lastText = null;
    for (const item of src.items) {
      const req = adapter.request({ ...item, productKey: item.key });
      const res = await fetchText(fetchImpl, req, { timeoutMs: 10000 });
      if (res.error) return { ok: false, error: res.error };
      lastText = res.text;
      let r;
      try {
        r = adapter.parse(res.text, { item: { ...item, productKey: item.key }, now: now(), status: res.status, url: res.url ?? req.url });
      } catch (e) {
        return { ok: false, error: `parse:${e?.message ?? e}` };
      }
      if (!r?.ok) return { ok: false, error: r?.error ?? classifyFailure(res.status, lastText) ?? 'parse:unknown' };
      products.push({ key: item.key, retailer: 'nvidia', shop: 'NVIDIA', model: item.model, title: item.title ?? r.title, url: r.url || item.url, price: r.price, inStock: r.inStock === true && !r.isPreorder, stockText: r.stockText ?? null, remind: item.remind === true });
    }
    return { ok: true, products };
  }
  return { ok: false, error: `unknown source type ${src.type}` };
}

// ---------- the drop log ----------

export function emptyDb() {
  return { v: 1, savedAt: null, products: {}, drops: [] };
}

export function loadDb(raw) {
  const e = emptyDb();
  if (!raw || typeof raw !== 'object') return e;
  return { ...e, ...raw, products: { ...(raw.products ?? {}) }, drops: [...(raw.drops ?? [])] };
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The lowest orderable price seen per day for each model (ours, merged over the config's seed), last 60 days. */
export function recordFloor(db, model, price, nowMs) {
  if (price == null) return;
  db.floor ??= {};
  const f = (db.floor[model] ??= {});
  const d = dayOf(nowMs);
  if (f[d] == null || price < f[d]) f[d] = price;
  for (const k of Object.keys(f)) if (Date.parse(k) < nowMs - 60 * 86400000) delete f[k];
}

/** Median of the daily lows of the last floorDays days before today; null with fewer than 3 days. */
export function floorOf(cfg, db, model, nowMs) {
  const m = cfg.models[model];
  if (!m) return null;
  const today = dayOf(nowMs);
  const from = dayOf(nowMs - m.floorDays * 86400000);
  const days = { ...(m.floorSeed ?? {}), ...(db?.floor?.[model] ?? {}) };
  const vals = Object.entries(days).filter(([d]) => d >= from && d < today).map(([, v]) => Number(v)).filter(Number.isFinite).sort((a, b) => a - b);
  if (vals.length < 3) return null;
  return vals[Math.floor(vals.length / 2)];
}

/** The price at or under which an orderable card counts as a drop: buyBelow, or dipPct under the recent low, whichever is higher. */
export function capFor(cfg, model, db = null, nowMs = Date.now()) {
  const m = cfg.models[model];
  if (!m) return null;
  const floor = m.dipPct != null && db ? floorOf(cfg, db, model, nowMs) : null;
  const dip = floor != null ? Math.round(floor * (1 - m.dipPct / 100)) : null;
  if (m.buyBelow == null) return dip;
  return dip == null ? m.buyBelow : Math.max(m.buyBelow, dip);
}

export function isDrop(cfg, p, db = null, nowMs = Date.now()) {
  if (!cfg.models[p.model]) return false; // a model we do not watch
  const cap = capFor(cfg, p.model, db, nowMs);
  return p.inStock === true && p.price != null && (cap == null || p.price <= cap);
}

/** Add publicly reported earlier drops (config pastDrops) that the log does not hold yet, oldest first. */
export function seedPastDrops(db, cfg) {
  let added = 0;
  for (const pd of cfg.pastDrops ?? []) {
    if (!pd?.id || !pd.start || db.drops.some((d) => d.id === pd.id)) continue;
    const end = pd.durationSec != null ? new Date(Date.parse(pd.start) + pd.durationSec * 1000).toISOString() : pd.end ?? null;
    db.drops.push({ url: null, uvp: cfg.models[pd.model]?.uvp ?? null, minPrice: pd.price ?? null, ...pd, end });
    added++;
  }
  if (added) db.drops.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return added;
}

/** The most recent drop of a model other than `exceptId` (open or closed). */
export function lastDropOf(db, model, exceptId = null) {
  for (let i = db.drops.length - 1; i >= 0; i--) {
    const d = db.drops[i];
    if (d.model === model && d.id !== exceptId) return d;
  }
  return null;
}

/**
 * Apply one source's readings. Returns events: { type: 'start' | 'end' | 'remind', drop, product }.
 * `seenKeys` lets a listing close drops of cards it still shows; a card missing from the listing is left alone until
 * MISSING_CLOSE_MIN has passed (it may only have slipped off the first page).
 */
export function applyReadings(db, cfg, src, products, nowMs) {
  const at = new Date(nowMs).toISOString();
  const events = [];
  const seen = new Set();
  // The day's low is recorded after the drop check, so a dip never lowers its own reference.
  const lows = {};
  for (const p of products) if (p.inStock && p.price != null && cfg.models[p.model]) lows[p.model] = Math.min(lows[p.model] ?? Infinity, p.price);
  for (const p of products) {
    seen.add(p.key);
    const prev = db.products[p.key] ?? null;
    const hit = isDrop(cfg, p, db, nowMs);
    const rec = { model: p.model, title: p.title, shop: p.shop, url: p.url, price: p.price, inStock: p.inStock, stockText: p.stockText, lastSeenAt: at, lastInStockAt: p.inStock ? at : prev?.lastInStockAt ?? null, openDrop: prev?.openDrop ?? null, lastSentAt: prev?.lastSentAt ?? 0 };
    if (hit && !rec.openDrop) {
      const drop = { id: `${p.key}@${at}`, key: p.key, model: p.model, title: p.title, shop: p.shop, url: p.url, start: at, end: null, durationSec: null, price: p.price, minPrice: p.price, uvp: cfg.models[p.model]?.uvp ?? null };
      db.drops.push(drop);
      rec.openDrop = drop.id;
      events.push({ type: 'start', drop, product: p });
    } else if (hit && rec.openDrop) {
      const drop = db.drops.find((d) => d.id === rec.openDrop);
      if (drop) {
        drop.minPrice = Math.min(drop.minPrice ?? p.price, p.price);
        if (p.remind && nowMs - (rec.lastSentAt || 0) >= cfg.remindMinutes * 60000) events.push({ type: 'remind', drop, product: p });
      }
    } else if (!hit && rec.openDrop) {
      const drop = db.drops.find((d) => d.id === rec.openDrop);
      if (drop) closeDrop(drop, at);
      rec.openDrop = null;
      if (drop) events.push({ type: 'end', drop, product: p });
    }
    db.products[p.key] = rec;
  }
  for (const [model, low] of Object.entries(lows)) recordFloor(db, model, low, nowMs);
  // Cards of this source's model that vanished from the listing: close their open drop after a while.
  if (src.type === 'alternate-listing' || src.type === 'mindfactory-search') {
    for (const [key, rec] of Object.entries(db.products)) {
      if (seen.has(key) || rec.model !== src.model || !key.startsWith(`${src.type.split('-')[0]}:`) || !rec.openDrop) continue;
      if (nowMs - Date.parse(rec.lastSeenAt) >= MISSING_CLOSE_MIN * 60000) {
        const drop = db.drops.find((d) => d.id === rec.openDrop);
        if (drop) closeDrop(drop, rec.lastSeenAt);
        rec.openDrop = null;
      }
    }
  }
  if (db.drops.length > KEEP_DROPS) db.drops.splice(0, db.drops.length - KEEP_DROPS);
  return events;
}

function closeDrop(drop, endIso) {
  drop.end = endIso;
  drop.durationSec = Math.max(0, Math.round((Date.parse(endIso) - Date.parse(drop.start)) / 1000));
}

// ---------- messages ----------

const euro = (n) => (n == null ? 'Preis ?' : `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`);
const berlin = (iso, withDate = true) =>
  new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', ...(withDate ? { day: '2-digit', month: '2-digit', year: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', ...(withDate ? {} : { second: '2-digit' }) });

export function duration(sec) {
  if (sec == null) return 'still open';
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 360) / 10} h`;
}

export function lastDropLine(db, cfg, model, exceptId) {
  const label = cfg.models[model]?.label ?? model;
  const d = lastDropOf(db, model, exceptId);
  if (!d) {
    const since = cfg.trackingSince?.[model] ?? db.firstRunAt ?? null;
    return `Last ${label} drop: none seen${since ? ` since ${berlin(since)}` : ''}`;
  }
  return `Last ${label} drop: ${d.approx ? 'about ' : ''}${berlin(d.start)}, ${d.end ? `lasted ${d.approx ? 'about ' : ''}${duration(d.durationSec)}` : 'still open'}, ${euro(d.minPrice ?? d.price)} at ${d.shop}`;
}

export function dropMessage(ev, db, cfg, nowMs) {
  const m = cfg.models[ev.drop.model] ?? {};
  const p = ev.product;
  const vs = m.uvp ? ` (UVP ${euro(m.uvp)}, ${p.price >= m.uvp ? '+' : ''}${(((p.price - m.uvp) / m.uvp) * 100).toFixed(0)}%)` : '';
  const floor = floorOf(cfg, db, ev.drop.model, nowMs);
  const low = floor != null && p.price != null ? `Market low, last ${m.floorDays} days: ${euro(floor)} (this is ${Math.round((1 - p.price / floor) * 100)}% under)` : null;
  return [
    ev.type === 'remind' ? `STILL IN STOCK: ${m.label ?? ev.drop.model}` : `DROP: ${m.label ?? ev.drop.model}`,
    p.title ?? ev.drop.title ?? p.key,
    `${euro(p.price)} at ${p.shop}${vs}`,
    ...(low ? [low] : []),
    `Buy: ${p.url}`,
    lastDropLine(db, cfg, ev.drop.model, ev.drop.id),
    `Checked ${berlin(new Date(nowMs).toISOString(), false)} Berlin. Max 1 per customer at most shops.`,
  ].join('\n');
}

export function summaryMessage(db, cfg) {
  const lines = Object.keys(cfg.models).map((model) => lastDropLine(db, cfg, model, null));
  return lines.join('\n');
}

// ---------- the loop ----------

/** Per-shop health and today's limit per model, kept in the log so the monitor page can show them. */
export function noteSource(db, cfg, src, r, nowMs) {
  const at = new Date(nowMs).toISOString();
  db.sources ??= {};
  const s = (db.sources[src.id] ??= { streak: 0 });
  s.type = src.type;
  s.everySec = src.everySec;
  s.checks = (s.checks ?? 0) + 1;
  if (r.ok) {
    const inStock = r.products.filter((p) => p.inStock && p.price != null);
    Object.assign(s, { lastOkAt: at, streak: 0, cards: r.products.length, inStock: inStock.length, cheapest: inStock.length ? Math.min(...inStock.map((p) => p.price)) : null });
  } else {
    Object.assign(s, { lastErrorAt: at, lastError: String(r.error ?? 'unknown').slice(0, 120), streak: (s.streak ?? 0) + 1 });
  }
  db.limits ??= {};
  for (const [model, m] of Object.entries(cfg.models)) {
    db.limits[model] = { label: m.label, uvp: m.uvp, buyBelow: m.buyBelow, dipPct: m.dipPct, floorDays: m.floorDays, floor: floorOf(cfg, db, model, nowMs), cap: capFor(cfg, model, db, nowMs) };
  }
}

/**
 * Run every source on its own timer until `untilMs`.
 * send(text) posts to the chats and resolves { ok }. save(db) persists the log and resolves { ok }.
 */
export async function runHot({ cfg, db, fetch: fetchImpl, send, save = async () => ({ ok: true }), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), untilMs, log = () => {} }) {
  const stats = Object.fromEntries(cfg.sources.map((s) => [s.id, { checks: 0, fails: 0, streak: 0, failAlerted: false, events: 0 }]));
  let sent = 0;
  let dirty = false;
  let lastSave = now();

  async function deliver(ev) {
    const model = cfg.models[ev.drop.model];
    if (!model?.alert) return;
    const res = await send(dropMessage(ev, db, cfg, now()));
    if (res?.ok) {
      sent++;
      const rec = db.products[ev.product.key];
      if (rec) rec.lastSentAt = now();
    } else log(`send failed: ${res?.error ?? ''}`);
  }

  // Saving never blocks a check: one save in flight at a time, the next one picks up whatever changed meanwhile.
  let inFlight = null;
  function maybeSave(force = false) {
    if (inFlight || !dirty || (!force && now() - lastSave < cfg.saveEverySec * 1000)) return inFlight;
    db.savedAt = new Date(now()).toISOString();
    dirty = false;
    lastSave = now();
    inFlight = Promise.resolve(save(JSON.parse(JSON.stringify(db))))
      .then((r) => {
        if (!r?.ok) {
          dirty = true;
          log(`save failed: ${r?.error ?? ''}`);
        }
      })
      .catch((e) => {
        dirty = true;
        log(`save failed: ${e?.message ?? e}`);
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  async function loopSource(src, offsetMs) {
    const st = stats[src.id];
    await sleep(offsetMs);
    while (now() < untilMs) {
      const startedAt = now();
      const r = await fetchSource(src, { fetch: fetchImpl, now });
      st.checks++;
      noteSource(db, cfg, src, r, now());
      dirty = true;
      if (!r.ok) {
        st.fails++;
        st.streak++;
        log(`${src.id}: ${r.error}`);
        if (st.streak >= cfg.failAlertAfter && !st.failAlerted) {
          st.failAlerted = true;
          const res = await send(`[hot watcher] ${src.id} failed ${st.streak} checks in a row (${r.error}). Drops there may be missed until it answers again.`);
          if (res?.ok) sent++;
        }
      } else {
        if (st.failAlerted) await send(`[hot watcher] ${src.id} answers again.`);
        st.streak = 0;
        st.failAlerted = false;
        const events = applyReadings(db, cfg, src, r.products, now());
        dirty = true;
        st.events += events.length;
        for (const ev of events) if (ev.type !== 'end') await deliver(ev);
        if (events.some((e) => e.type !== 'remind')) maybeSave(true);
      }
      maybeSave();
      const wait = src.everySec * 1000 - (now() - startedAt);
      if (now() + Math.max(0, wait) >= untilMs) break;
      await sleep(Math.max(1000, wait));
    }
  }

  await Promise.all(cfg.sources.map((s, i) => loopSource(s, i * 1500)));
  if (inFlight) await inFlight;
  await maybeSave(true);
  return { sent, stats };
}

/** Telegram sendMessage to one or more chats, plain text. ok when at least the first chat got it. */
export function telegramSender({ token, chatIds, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), apiBase = 'https://api.telegram.org' }) {
  const ids = (Array.isArray(chatIds) ? chatIds : String(chatIds ?? '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);
  return async (text) => {
    if (!token || !ids.length) return { ok: false, error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID not set' };
    const results = [];
    for (const chatId of ids) {
      try {
        const res = await fetchImpl(`${apiBase}/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3500), link_preview_options: { is_disabled: true } }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json().catch(() => null);
        results.push(data?.ok ? { ok: true } : { ok: false, error: `telegram ${res.status} ${data?.description ?? ''}`.trim() });
      } catch (e) {
        results.push({ ok: false, error: `network: ${e?.message ?? e}` });
      }
    }
    return results[0];
  };
}
