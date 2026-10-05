// Cloudflare Workers KV adapter for the shared Store interface.
// KV notes: expirationTtl must be >= 60 s, so shorter TTLs are rounded up.
// Free plan: 1,000 writes/day and 1,000 list calls/day, so the engine keeps one state document
// and never calls list().
export function kvStore(ns, { prefix = '' } = {}) {
  if (!ns) throw new Error('KV namespace binding missing (wrangler.toml [[kv_namespaces]] binding = "DROP_RADAR")');
  return {
    async get(key) {
      const v = await ns.get(prefix + key);
      if (v === null) return null;
      try { return JSON.parse(v); } catch { return v; }
    },
    async put(key, value, ttlSec) {
      const body = typeof value === 'string' ? value : JSON.stringify(value);
      const opts = ttlSec ? { expirationTtl: Math.max(60, Math.ceil(ttlSec)) } : undefined;
      await ns.put(prefix + key, body, opts);
    },
    async list(p = '') {
      const keys = [];
      let cursor;
      do {
        const r = await ns.list({ prefix: prefix + p, cursor });
        for (const k of r.keys) keys.push(k.name.slice(prefix.length));
        cursor = r.list_complete ? undefined : r.cursor;
      } while (cursor);
      return keys;
    },
  };
}
