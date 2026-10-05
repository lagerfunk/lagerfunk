// Cloudflare Workers KV store. Note KV limits: free plan 1,000 writes per day, paid plan 1M writes per month
// included. The monitor only writes on change, so a 20-item watchlist stays in the low hundreds of writes per day.
export function createKvStore(namespace, { prefix = '' } = {}) {
  if (!namespace) throw new Error('createKvStore: KV namespace binding is required');
  return {
    async get(key) {
      return (await namespace.get(prefix + key, 'json')) ?? null;
    },
    async put(key, value, ttlSec) {
      const opts = ttlSec ? { expirationTtl: Math.max(60, Math.round(ttlSec)) } : undefined;
      await namespace.put(prefix + key, JSON.stringify(value), opts);
    },
    async list(p = '') {
      const keys = [];
      let cursor;
      do {
        const res = await namespace.list({ prefix: prefix + p, cursor });
        for (const k of res.keys) keys.push(k.name.slice(prefix.length));
        cursor = res.list_complete ? undefined : res.cursor;
      } while (cursor);
      return keys.sort();
    },
    async delete(key) {
      await namespace.delete(prefix + key);
    },
  };
}
