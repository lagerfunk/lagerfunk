// JSON file store for Node (Heroku dyno or a laptop). Node-only: imports node:fs. Writes are debounced and atomic.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function createJsonFileStore(path, { now = () => Date.now(), flushMs = 2000 } = {}) {
  let data = {};
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let timer = null;
  let writing = Promise.resolve();
  const alive = (e) => e && (!e.exp || e.exp > now());

  async function flush() {
    timer = null;
    const snapshot = JSON.stringify(data);
    writing = writing.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, path);
    });
    return writing;
  }
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, flushMs);
  };

  return {
    async get(key) {
      const e = data[key];
      if (!alive(e)) return null;
      return structuredClone(e.v);
    },
    async put(key, value, ttlSec) {
      data[key] = { v: structuredClone(value), exp: ttlSec ? now() + ttlSec * 1000 : 0 };
      schedule();
    },
    async list(prefix = '') {
      return Object.keys(data).filter((k) => k.startsWith(prefix) && alive(data[k])).sort();
    },
    async delete(key) {
      delete data[key];
      schedule();
    },
    async close() {
      if (timer) clearTimeout(timer);
      await flush();
    },
  };
}
