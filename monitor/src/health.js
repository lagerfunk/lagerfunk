// Per-retailer health, backoff and proxy stickiness. Kept in memory, persisted to the store key "health" only when a
// retailer's status changes or every flushEveryMs, so KV writes stay low.
import { isBlockError } from './check.js';

export const HEALTH_KEY = 'health';

export function createHealth({ baseBackoffMs = 60000, maxBackoffMs = 30 * 60000, proxyStickyMs = 6 * 3600000, random = Math.random } = {}) {
  const r = new Map();
  let dirty = false;

  const get = (id) => {
    if (!r.has(id)) {
      r.set(id, { status: 'ok', checks: 0, ok: 0, fail: 0, blocked: 0, consecutiveFail: 0, recent: '', lastStatus: null, lastError: null, lastOkAt: null, lastFailAt: null, bytes: 0, proxyBytes: 0, pausedUntil: 0, proxyUntil: 0 });
    }
    return r.get(id);
  };

  return {
    get,
    load(snapshot) {
      for (const [id, v] of Object.entries(snapshot?.retailers ?? {})) r.set(id, { ...get(id), ...v });
    },
    /** Record one attempt. Returns the new status if it changed. */
    record(id, { ok, error, httpStatus, bytes = 0, viaProxy = false, at = Date.now() }) {
      const h = get(id);
      const before = h.status;
      h.checks++;
      h.lastStatus = httpStatus ?? null;
      if (viaProxy) h.proxyBytes += bytes;
      else h.bytes += bytes;
      const blockish = !ok && isBlockError(error);
      const countsAsFail = !ok && (blockish || error === 'timeout' || String(error).startsWith('network'));
      h.recent = (h.recent + (countsAsFail ? 'x' : 'o')).slice(-20);
      if (ok || !countsAsFail) {
        if (ok) {
          h.ok++;
          h.lastOkAt = new Date(at).toISOString();
        }
        h.consecutiveFail = 0;
        h.pausedUntil = 0;
        if (!ok) h.lastError = error;
      } else {
        h.fail++;
        if (blockish) h.blocked++;
        h.consecutiveFail++;
        h.lastError = error;
        h.lastFailAt = new Date(at).toISOString();
        const base = error === 'rate_limited' ? baseBackoffMs * 2 : baseBackoffMs;
        const wait = Math.min(maxBackoffMs, base * 2 ** Math.min(10, h.consecutiveFail - 1)) * (0.8 + 0.4 * random());
        h.pausedUntil = at + Math.round(wait);
      }
      const fails = [...h.recent].filter((c) => c === 'x').length;
      h.status = h.consecutiveFail >= 5 ? 'blocked' : h.recent.length >= 5 && fails / h.recent.length >= 0.5 ? 'degraded' : 'ok';
      dirty = true;
      return h.status !== before ? h.status : null;
    },
    isPaused(id, now = Date.now()) {
      return get(id).pausedUntil > now;
    },
    stickToProxy(id, now = Date.now()) {
      get(id).proxyUntil = now + proxyStickyMs;
      dirty = true;
    },
    prefersProxy(id, now = Date.now()) {
      return get(id).proxyUntil > now;
    },
    snapshot(now = Date.now()) {
      return { updatedAt: new Date(now).toISOString(), retailers: Object.fromEntries(r) };
    },
    get dirty() {
      return dirty;
    },
    clean() {
      dirty = false;
    },
  };
}
