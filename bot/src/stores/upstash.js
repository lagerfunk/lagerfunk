// Upstash Redis (REST) adapter. fetch-only, so it runs in Node and Workers.
// Use this on Heroku: a dyno's disk is wiped on every restart, so a file store would lose the delay queue.
export function upstashStore({ url, token, fetch: fetchImpl = globalThis.fetch }) {
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
  const base = url.replace(/\/$/, '');
  async function cmd(args) {
    const res = await fetchImpl(base, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(`Upstash ${args[0]} failed: ${data.error || res.status}`);
    return data.result;
  }
  return {
    async get(key) {
      const v = await cmd(['GET', key]);
      if (v === null || v === undefined) return null;
      try { return JSON.parse(v); } catch { return v; }
    },
    async put(key, value, ttlSec) {
      const body = typeof value === 'string' ? value : JSON.stringify(value);
      await cmd(ttlSec ? ['SET', key, body, 'EX', String(Math.max(1, Math.ceil(ttlSec)))] : ['SET', key, body]);
    },
    async list(prefix = '') {
      const keys = [];
      let cursor = '0';
      const pattern = `${prefix.replace(/([*?[\]\\])/g, '\\$1')}*`;
      do {
        const [next, batch] = await cmd(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '500']);
        keys.push(...batch);
        cursor = String(next);
      } while (cursor !== '0');
      return [...new Set(keys)].sort();
    },
  };
}
