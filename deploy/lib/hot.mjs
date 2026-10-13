// Hot watcher: a few products checked every 30 s to 5 min, alerts to the owner's private admin chat only.
//
// Why it exists: the main runner checks every 10 minutes, and a Founders Edition drop sells out faster than that. This
// loop reuses the monitor's own shop adapters, keeps its memory for the length of one run (about 50 minutes) and sends a
// plain-text Telegram message with the shop's own buy link. It never logs in, never fills a cart and never orders:
// buying stays a human tap. Config: deploy/config/hot.json.
import { adapterById } from '../../monitor/src/adapters/index.js';
import { fetchText } from '../../monitor/src/fetcher.js';
import { classifyFailure } from '../../monitor/src/check.js';

export const HOT_CONFIG_FILE = 'deploy/config/hot.json';
export const MIN_EVERY_SEC = 20; // politeness floor per item, whatever the config says

export function normalizeHot(raw) {
  const items = (raw?.items ?? [])
    .filter((i) => i && i.key && i.retailer && i.url && i.enabled !== false)
    .map((i) => ({
      ...i,
      productKey: i.productKey ?? i.key,
      everySec: Math.max(MIN_EVERY_SEC, Number(i.everySec) || 60),
      maxPrice: i.maxPrice == null ? null : Number(i.maxPrice),
    }));
  return {
    loopMinutes: Math.min(55, Math.max(1, Number(raw?.loopMinutes) || 50)),
    remindMinutes: Math.max(5, Number(raw?.remindMinutes) || 15),
    failAlertAfter: Math.max(3, Number(raw?.failAlertAfter) || 20),
    items,
  };
}

/** Can be ordered now at or under the item's cap. */
export function isHit(item, r) {
  if (!r?.ok || r.inStock !== true || r.isPreorder) return false;
  if (r.soldByRetailer === false) return false; // marketplace resellers are not the drop
  if (item.maxPrice != null && (r.price == null || r.price > item.maxPrice)) return false;
  return true;
}

const euro = (n) => (n == null ? 'Preis ?' : `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`);

export function hitMessage(item, r, adapterName, atMs, { reminder = false } = {}) {
  const t = new Date(atMs).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return [
    reminder ? 'STILL IN STOCK' : 'IN STOCK NOW',
    `${item.title ?? r.title ?? item.key}`,
    `${euro(r.price)} at ${adapterName}${r.stockText ? ` (${r.stockText})` : ''}`,
    `Buy: ${r.url || item.url}`,
    `Checked ${t} Berlin. Max 1 per customer at most shops.`,
  ].join('\n');
}

/** One check of one item through the monitor's adapter. Never throws. */
export async function checkOnce(item, { fetch: fetchImpl, now = () => Date.now() }) {
  const adapter = adapterById(item.retailer);
  if (!adapter) return { ok: false, error: `no adapter for ${item.retailer}` };
  const req = adapter.request(item);
  const res = await fetchText(fetchImpl, req, { timeoutMs: 15000 });
  if (res.error) return { ok: false, error: res.error, httpStatus: res.status };
  try {
    const parsed = adapter.parse(res.text, { item, now: now(), status: res.status, url: res.url ?? req.url });
    if (!parsed?.ok) return { ok: false, error: parsed?.error ?? classifyFailure(res.status, res.text) ?? 'parse:unknown', httpStatus: res.status };
    return { ...parsed, ok: true, httpStatus: res.status, adapterName: adapter.name ?? adapter.id };
  } catch (e) {
    return { ok: false, error: `parse:${e?.message ?? e}`, httpStatus: res.status };
  }
}

/**
 * Run the loop until `untilMs`. `send(text)` posts to the admin chat and resolves { ok }.
 * Returns a summary: checks, hits, sent, failures per item.
 */
export async function runHot({ cfg, fetch: fetchImpl, send, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), untilMs, log = () => {}, tickMs = 5000 }) {
  const st = Object.fromEntries(cfg.items.map((i) => [i.key, { nextAt: 0, hitSince: null, lastSentAt: 0, fails: 0, failAlerted: false, checks: 0, hits: 0 }]));
  let sent = 0;
  let checks = 0;
  // Spread the slow items over their interval so they do not all hit the shop in the same second.
  cfg.items.forEach((i, n) => { st[i.key].nextAt = now() + Math.min(i.everySec * 1000, n * 7000); });
  while (now() < untilMs) {
    for (const item of cfg.items) {
      const s = st[item.key];
      if (now() < s.nextAt) continue;
      s.nextAt = now() + item.everySec * 1000;
      const r = await checkOnce(item, { fetch: fetchImpl, now });
      checks++;
      s.checks++;
      if (!r.ok) {
        s.fails++;
        log(`${item.key}: ${r.error}`);
        if (s.fails >= cfg.failAlertAfter && !s.failAlerted) {
          s.failAlerted = true;
          const res = await send(`[hot watcher] ${item.title ?? item.key} at ${item.retailer} failed ${s.fails} checks in a row (${r.error}). Alerts for it may be missing until it answers again.`);
          if (res?.ok) sent++;
        }
        continue;
      }
      s.fails = 0;
      s.failAlerted = false;
      const t = now();
      if (isHit(item, r)) {
        s.hits++;
        const fresh = s.hitSince == null;
        if (fresh) s.hitSince = t;
        const due = fresh || t - s.lastSentAt >= cfg.remindMinutes * 60000;
        if (due) {
          const res = await send(hitMessage(item, r, r.adapterName, t, { reminder: !fresh }));
          if (res?.ok) {
            sent++;
            s.lastSentAt = t;
          } else {
            log(`${item.key}: send failed ${res?.error ?? ''}`);
            if (fresh) s.hitSince = null; // try again on the next check
          }
        }
      } else {
        s.hitSince = null;
      }
    }
    if (now() >= untilMs) break;
    await sleep(tickMs);
  }
  return {
    checks,
    sent,
    items: Object.fromEntries(Object.entries(st).map(([k, s]) => [k, { checks: s.checks, hits: s.hits, fails: s.fails }])),
  };
}

/** Telegram sendMessage to one chat, plain text. */
export function telegramSender({ token, chatId, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), apiBase = 'https://api.telegram.org' }) {
  return async (text) => {
    if (!token || !chatId) return { ok: false, error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID not set' };
    try {
      const res = await fetchImpl(`${apiBase}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3500), link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => null);
      return data?.ok ? { ok: true } : { ok: false, error: `telegram ${res.status} ${data?.description ?? ''}`.trim() };
    } catch (e) {
      return { ok: false, error: `network: ${e?.message ?? e}` };
    }
  };
}
