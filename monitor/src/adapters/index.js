import amazon from './amazon.js';
import psdirect from './psdirect.js';
import nvidia from './nvidia.js';
import { mediamarkt, saturn } from './mediamarkt.js';
import { otto, mueller, notebooksbilliger, alternate, galaxus, euronics, expert, cyberport, smyths, generic } from './shops.js';
import { hostOf } from '../util.js';

export const ADAPTERS = [amazon, mediamarkt, saturn, psdirect, nvidia, otto, mueller, notebooksbilliger, alternate, galaxus, euronics, expert, cyberport, smyths];
export { generic };

const ALIASES = { nbb: 'notebooksbilliger', 'media markt': 'mediamarkt', 'playstation direct': 'psdirect', 'ps direct': 'psdirect', 'müller': 'mueller', smythstoys: 'smyths' };

export function adapterById(id) {
  const k = String(id ?? '').toLowerCase().trim();
  const want = ALIASES[k] ?? k;
  return ADAPTERS.find((a) => a.id === want) ?? null;
}

export function adapterForUrl(url) {
  const host = hostOf(url);
  return ADAPTERS.find((a) => a.hosts.some((h) => host === h || host.endsWith('.' + h))) ?? null;
}

/** Adapter for a watch item: explicit retailer id first, then URL host, then the generic structured-data adapter. */
export function adapterFor(item) {
  return adapterById(item.retailer) ?? adapterForUrl(item.url) ?? generic;
}

/** Retailer id written into Checks and Alerts. Unknown shops use their host, e.g. "lidl.de". */
export function retailerIdFor(item, adapter = adapterFor(item)) {
  if (adapter !== generic) return adapter.id;
  return item.retailer ? String(item.retailer).toLowerCase() : hostOf(item.url) || 'unknown';
}
