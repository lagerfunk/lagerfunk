// Store interface: { get(key), put(key, value, ttlSec?), list(prefix) }. Values are plain JSON-able objects.
export function createMemoryStore({ now = () => Date.now() } = {}) {
  const map = new Map();
  const alive = (e) => e && (!e.exp || e.exp > now());
  return {
    async get(key) {
      const e = map.get(key);
      if (!alive(e)) {
        map.delete(key);
        return null;
      }
      return structuredClone(e.v);
    },
    async put(key, value, ttlSec) {
      map.set(key, { v: structuredClone(value), exp: ttlSec ? now() + ttlSec * 1000 : 0 });
    },
    async list(prefix = '') {
      return [...map.entries()].filter(([k, e]) => k.startsWith(prefix) && alive(e)).map(([k]) => k).sort();
    },
    async delete(key) {
      map.delete(key);
    },
    _dump: () => Object.fromEntries([...map.entries()].map(([k, e]) => [k, e.v])),
  };
}
