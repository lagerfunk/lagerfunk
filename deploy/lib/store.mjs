// The runner's Store: everything lives in memory during one run and is written out once at the end.
// Same interface as the monitor and bot stores: get, put(key, value, ttlSec), list(prefix), delete.
// The file format is valid JSON with one entry per line, so a diff of two states is readable on GitHub.

export const STATE_VERSION = 1;

export function createStateStore({ entries = {}, now = () => Date.now() } = {}) {
  const data = new Map(Object.entries(entries));
  const alive = (e) => e && typeof e === 'object' && (!e.exp || e.exp > now());
  return {
    async get(key) {
      const e = data.get(key);
      if (!alive(e)) {
        data.delete(key);
        return null;
      }
      return structuredClone(e.v);
    },
    async put(key, value, ttlSec) {
      data.set(key, { v: structuredClone(value), exp: ttlSec ? now() + ttlSec * 1000 : 0 });
    },
    async list(prefix = '') {
      return [...data.entries()].filter(([k, e]) => k.startsWith(prefix) && alive(e)).map(([k]) => k).sort();
    },
    async delete(key) {
      data.delete(key);
    },
    /** Live entries only, sorted by key. */
    entries() {
      return Object.fromEntries([...data.entries()].filter(([, e]) => alive(e)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    },
  };
}

/** Entries -> file text. One entry per line. */
export function serializeState(entries, { savedAt, runId = null } = {}) {
  const head = `{"v":${STATE_VERSION},"savedAt":${JSON.stringify(savedAt)},"runId":${JSON.stringify(runId)},"entries":{`;
  const lines = Object.entries(entries).map(([k, e]) => `${JSON.stringify(k)}:${JSON.stringify(e)}`);
  return `${head}\n${lines.join(',\n')}\n}}\n`;
}

/** File text -> { ok, entries, savedAt }. Anything unexpected is "not ok", never a partial state. */
export function parseState(text) {
  try {
    const doc = JSON.parse(text);
    if (!doc || doc.v !== STATE_VERSION || !doc.entries || typeof doc.entries !== 'object' || Array.isArray(doc.entries)) return { ok: false, entries: {}, savedAt: null };
    for (const e of Object.values(doc.entries)) if (!e || typeof e !== 'object' || !('v' in e)) return { ok: false, entries: {}, savedAt: null };
    return { ok: true, entries: doc.entries, savedAt: doc.savedAt ?? null };
  } catch {
    return { ok: false, entries: {}, savedAt: null };
  }
}
