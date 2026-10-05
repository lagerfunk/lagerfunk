// In-memory Store for tests and local dry runs. Same interface as the shared Store:
// { get(key), put(key, value, ttlSec?), list(prefix) }
export function memoryStore({ clock = { now: () => Date.now() } } = {}) {
  const m = new Map();
  const alive = (e) => !e.exp || e.exp > clock.now();
  return {
    _map: m,
    async get(key) {
      const e = m.get(key);
      if (!e) return null;
      if (!alive(e)) { m.delete(key); return null; }
      return JSON.parse(e.v);
    },
    async put(key, value, ttlSec) {
      m.set(key, { v: JSON.stringify(value), exp: ttlSec ? clock.now() + ttlSec * 1000 : 0 });
    },
    async list(prefix = '') {
      return [...m.entries()].filter(([k, e]) => k.startsWith(prefix) && alive(e)).map(([k]) => k).sort();
    },
  };
}
