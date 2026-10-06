// Thresholds for the circuit breakers, the watchdog and the ops commands: deploy/config/breakers.json.
// The defaults below are the same numbers, so a missing file never disables a breaker. A file with a wrong type
// (a string where a number belongs, a negative number) is refused with a clear message instead of being half used.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const OPS_CONFIG_FILE = 'deploy/config/breakers.json';

export const OPS_DEFAULTS = Object.freeze({
  deadman: { alertAfterMinutes: 40, remindEveryMinutes: 360, blindAfterMinutes: 120, firstRunGraceMinutes: 60, watchdogStaleMinutes: 180 },
  retailer: { tripAfterFailures: 5, openMinutes: 30, maxOpenMinutes: 720, ignoreErrors: ['not_found'] },
  surge: { maxInStockFlipsPerRun: 8, maxInStockFlipsPerRetailer: 5, holdMinutes: 60 },
  price: { minPctOfMedian: 50, maxPctOfMedian: 250, minHistoryDays: 3 },
  telegram: { tripAfterFailedRuns: 3, openMinutes: 10, maxOpenMinutes: 360, authOpenMinutes: 30, longRetryAfterSec: 60 },
  dedupe: { windowMinutes: { restock: 60, ships_before: 60, price_drop: 720, lowest_30d: 1440 }, keepHours: 72 },
  affiliate: { checkLinks: true },
  admin: { maxPerRun: 4, cooldownMinutes: 360, outboxMax: 20, outboxTtlHours: 24 },
  held: { max: 50, keepHours: 24 },
  digest: { hourBerlin: 8 },
  backups: { keep: 7 },
  keepalive: { warnAfterDays: 45, actAfterDays: 50 },
  smoke: { minOkChecks: 1 },
  promotion: { minGoodRuns24h: 12, maxFailedRuns24h: 2, maxOpenBreakers: 0 },
});

function merge(base, over, at, errors) {
  if (over === undefined) return structuredClone(base);
  if (Array.isArray(base)) {
    if (!Array.isArray(over) || !over.every((x) => typeof x === 'string')) errors.push(`${at} must be a list of strings`);
    return Array.isArray(over) ? [...over] : [...base];
  }
  if (base && typeof base === 'object') {
    if (!over || typeof over !== 'object' || Array.isArray(over)) {
      errors.push(`${at} must be an object`);
      return structuredClone(base);
    }
    const out = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
      if (k === 'note') continue;
      out[k] = k in base ? merge(base[k], over[k], `${at}.${k}`, errors) : over[k];
    }
    return out;
  }
  if (typeof base === 'number') {
    if (typeof over !== 'number' || !Number.isFinite(over) || over < 0) errors.push(`${at} must be a number >= 0 (got ${JSON.stringify(over)})`);
    return typeof over === 'number' && Number.isFinite(over) && over >= 0 ? over : base;
  }
  if (typeof base === 'boolean') {
    if (typeof over !== 'boolean') errors.push(`${at} must be true or false`);
    return typeof over === 'boolean' ? over : base;
  }
  return over;
}

/** Validate and merge a parsed config over the defaults. Throws listing every problem. */
export function resolveOpsConfig(raw = {}) {
  const errors = [];
  const cfg = merge(OPS_DEFAULTS, raw, 'breakers', errors);
  if (errors.length) throw new Error(`${OPS_CONFIG_FILE} is invalid: ${errors.join('; ')}`);
  return cfg;
}

/** Read deploy/config/breakers.json under `root` (the project or bundle root). */
export function loadOpsConfig({ root, file = null } = {}) {
  const f = file ?? path.join(root ?? process.cwd(), OPS_CONFIG_FILE);
  if (!existsSync(f)) return resolveOpsConfig({});
  let raw;
  try {
    raw = JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    throw new Error(`${OPS_CONFIG_FILE} is not valid JSON: ${e.message}`);
  }
  return resolveOpsConfig(raw);
}
