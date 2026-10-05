// Profiles decide, per retailer, whether an item is fetched by scraping, read from a product feed, or switched off.
// One config value picks the profile (env PROFILE, CLI --profile, or the `default` in config/profiles.json).
// Runtime neutral: only imports the JSON file.
import data from '../config/profiles.json' with { type: 'json' };

export const PROFILE_NAMES = Object.keys(data.profiles);

/** Resolve a profile by name. Unknown names throw, so a typo never silently runs the expensive profile. */
export function resolveProfile(name, source = data) {
  const wanted = String(name ?? source.default ?? 'free').toLowerCase().trim();
  const p = source.profiles?.[wanted];
  if (!p) throw new Error(`unknown profile "${wanted}". Available: ${Object.keys(source.profiles ?? {}).join(', ')}`);
  return { name: wanted, description: p.description ?? '', proxy: p.proxy ?? 'allowed', retailers: p.retailers ?? {} };
}

/** The proxy may be used only when the profile allows it. */
export const proxyAllowed = (profile) => !profile || profile.proxy !== 'never';

function ruleFor(profile, retailer) {
  return profile.retailers[retailer] ?? profile.retailers['*'] ?? { scrape: true, feed: true };
}

/**
 * Where does an item of this retailer get its data?
 * @returns {{ active: boolean, source: 'scrape'|'feed'|null, reason: string|null }}
 */
export function decide(profile, retailer, { feedConfigured = false } = {}) {
  if (!profile) return { active: true, source: 'scrape', reason: null };
  const rule = ruleFor(profile, retailer);
  const canScrape = rule.scrape !== false;
  const canFeed = rule.feed !== false && feedConfigured;
  const order = rule.prefer === 'feed' ? ['feed', 'scrape'] : ['scrape', 'feed'];
  for (const s of order) {
    if (s === 'scrape' && canScrape) return { active: true, source: 'scrape', reason: null };
    if (s === 'feed' && canFeed) return { active: true, source: 'feed', reason: null };
  }
  const waiting = rule.feed !== false && !feedConfigured ? ` Waiting for a feed: set FEED_URL_${String(retailer).toUpperCase().replace(/[^A-Z0-9]/g, '_')}.` : '';
  return { active: false, source: null, reason: `${rule.reason ?? 'Disabled in this profile.'}${waiting}`.trim() };
}

/**
 * Split watch items into active and disabled for a profile. Disabled items stay in the watchlist file untouched.
 * `feedRetailers` is a Set (or object) of retailer ids that have a configured feed.
 */
export function partition(items, profile, feedRetailers = new Set()) {
  const has = (r) => (feedRetailers instanceof Set ? feedRetailers.has(r) : Boolean(feedRetailers?.[r]));
  const active = [];
  const disabled = [];
  for (const it of items) {
    const d = decide(profile, it.retailer, { feedConfigured: has(it.retailer) });
    if (d.active) active.push({ ...it, _source: d.source });
    else disabled.push({ ...it, _disabledReason: d.reason });
  }
  return { active, disabled };
}

/** One line per retailer: what is on, from where, and why the rest is off. */
export function summarize(active, disabled) {
  const by = {};
  for (const it of active) {
    const r = (by[it.retailer] ??= { retailer: it.retailer, source: it._source, items: 0, reason: null });
    r.items++;
  }
  for (const it of disabled) {
    const r = (by[it.retailer] ??= { retailer: it.retailer, source: null, items: 0, reason: it._disabledReason });
    r.items++;
  }
  return Object.values(by).sort((a, b) => Number(Boolean(b.source)) - Number(Boolean(a.source)) || a.retailer.localeCompare(b.retailer));
}
