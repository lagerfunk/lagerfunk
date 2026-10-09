// The weekly Lagerfunk Marktbericht: one post per ISO week (Friday 18:00 Berlin by default), built only from the runner's
// own measurements in market:log (deploy/lib/marketlog.mjs). Per category: the lowest current price per product group
// with shop and "Stand", hours in stock in the last 7 days for the key products (at or below the list price when the
// watchlist has one), restocks, and for consoles the delivery dates before GTA VI. Aggregated and dated: no listing dumps,
// no Amazon, no marketplace sellers, no percent sign, no discount wording, no price comparison over time.
// The same report is written as a small static HTML page and JSON (deploy/out/report-YYYY-WW.html/.json) for the site.
//
// Schedule and feature flag: marketReport in deploy/config/breakers.json. What it shows: deploy/config/market-report.json.
// Idempotent: the state key market:report remembers every ISO week that was handled; the runner marks the week before it
// posts (inside the checkpoint), so chained runs and retries never post a second report for the same week.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadLog, isExcluded, buyableMinutes, MIN } from './marketlog.mjs';
import { escapeHtml as esc, formatEuro } from '../../bot/src/util.js';
import { cleanTitle } from '../../bot/src/format.js';
import { visibleLength } from '../../bot/src/telegram.js';
import { assertCompliant } from '../../bot/src/pricing.js';
import { looksLikeAffiliateUrl } from '../../bot/src/affiliate.js';

export const MARKET_REPORT_KEY = 'market:report';
export const REPORT_CONFIG_FILE = 'deploy/config/market-report.json';
export const REQUIRED_LINE = 'Preise ändern sich laufend, maßgeblich ist der Shop.';
const HOUR = 3600000;
const DAY = 86400000;
const KEEP_WEEK_MARKS = 26;

// ---------------------------------------------------------------- config

/** Validate deploy/config/market-report.json and compile its patterns. Throws listing every problem. */
export function resolveReportConfig(raw) {
  const errors = [];
  const at = REPORT_CONFIG_FILE;
  const re = (s, where) => {
    try {
      return new RegExp(s);
    } catch (e) {
      errors.push(`${where}: "${s}" is not a valid pattern (${e.message})`);
      return /^$/;
    }
  };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.categories) || !raw.categories.length) throw new Error(`${at}: needs a list "categories"`);
  const ids = new Set();
  const categories = raw.categories.map((c, i) => {
    const where = `${at} categories[${i}]`;
    if (!c?.id || !c.label || !c.pattern) errors.push(`${where}: id, label and pattern are required`);
    if (ids.has(c?.id)) errors.push(`${where}: id "${c.id}" is used twice`);
    ids.add(c?.id);
    if (c?.deliveryBefore && !/^\d{4}-\d{2}-\d{2}$/.test(c.deliveryBefore)) errors.push(`${where}: deliveryBefore must be YYYY-MM-DD`);
    const gids = new Set();
    const groups = (c?.groups ?? []).map((g, j) => {
      const gw = `${where} groups[${j}]`;
      if (!g?.id || !g.label || (!g.pattern && !g.keys?.length)) errors.push(`${gw}: id, label and pattern or keys are required`);
      if (gids.has(g?.id)) errors.push(`${gw}: id "${g.id}" is used twice`);
      gids.add(g?.id);
      return { id: g.id, label: g.label, key: g.key === true, variants: g.variants === true, keys: g.keys ?? null, re: g.pattern ? re(g.pattern, gw) : null };
    });
    return { id: c.id, label: c.label, emoji: c.emoji ?? '', re: re(c.pattern, where), deliveryBefore: c.deliveryBefore ?? null, deliveryLabel: c.deliveryLabel ?? null, groups };
  });
  if (errors.length) throw new Error(`${at} is invalid: ${errors.join('; ')}`);
  return {
    // Amazon is left out in code (marketlog.isExcluded); this list can only add shops.
    excludeRetailers: [...new Set(['amazon', ...(raw.excludeRetailers ?? [])].map((x) => String(x).toLowerCase()))],
    channelUrl: raw.channelUrl || '',
    utm: { source: raw.utm?.source || 'lagerfunk-site', medium: raw.utm?.medium || 'marktbericht' },
    categories,
  };
}

export function loadReportConfig({ root, file = null } = {}) {
  const f = file ?? path.join(root ?? process.cwd(), REPORT_CONFIG_FILE);
  if (!existsSync(f)) throw new Error(`${REPORT_CONFIG_FILE} is missing`);
  let raw;
  try {
    raw = JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    throw new Error(`${REPORT_CONFIG_FILE} is not valid JSON: ${e.message}`);
  }
  return resolveReportConfig(raw);
}

// ---------------------------------------------------------------- time

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmts = new Map();
/** Wall clock parts of `ms` in time zone `tz`. dow: 0 Sunday ... 6 Saturday. */
export function zoned(ms, tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' });
    fmts.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), hh: Number(o.hour), mm: Number(o.minute), ss: Number(o.second), dow: DOW[o.weekday] };
}

function offsetMs(ms, tz) {
  const z = zoned(ms, tz);
  return Date.UTC(z.y, z.m - 1, z.d, z.hh, z.mm, z.ss) - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` shows y-m-d hh:mm. */
export function zonedToUtc({ y, m, d, hh = 0, mm = 0 }, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const t = guess - offsetMs(guess, tz);
  const o2 = offsetMs(t, tz);
  return guess - o2;
}

/** ISO 8601 week of a calendar date: { year, week }. */
export function isoWeek(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const year = date.getUTCFullYear();
  return { year, week: Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7) };
}
export const weekId = ({ year, week }) => `${year}-W${String(week).padStart(2, '0')}`;
export const weekOf = (ms, tz) => {
  const z = zoned(ms, tz);
  return weekId(isoWeek(z.y, z.m, z.d));
};
/** "2026-W42" -> "2026-42" (file names) */
export const weekFile = (week) => String(week).replace('-W', '-');

/** The report slot of the ISO week that contains `ms` and of the week before (a late window can reach into the next week). */
export function slotsAround(ms, cfg) {
  const z = zoned(ms, cfg.timezone);
  const monday = Date.UTC(z.y, z.m - 1, z.d) - ((z.dow || 7) - 1) * DAY;
  return [0, 7].map((back) => {
    const day = new Date(monday - back * DAY + ((cfg.weekday || 7) - 1) * DAY);
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const at = zonedToUtc({ y, m, d, hh: cfg.hour }, cfg.timezone);
    return { week: weekId(isoWeek(y, m, d)), at, until: at + cfg.lateHours * HOUR };
  });
}

export function loadReportState(raw) {
  const s = raw && typeof raw === 'object' && raw.v === 1 ? structuredClone(raw) : { v: 1, weeks: {}, reports: {} };
  s.weeks ??= {};
  s.reports ??= {};
  return s;
}

/**
 * Is a report due now? { due, week, at, until, reason }. reason: off | not-time | not-started (slot before firstDate) |
 * done (with the week's mark) | due.
 */
export function reportPlan(ms, cfg, state) {
  const st = loadReportState(state);
  if (!cfg.enabled) return { due: false, reason: 'off' };
  const slot = slotsAround(ms, cfg).find((s) => ms >= s.at && ms < s.until);
  if (!slot) return { due: false, reason: 'not-time' };
  if (cfg.firstDate) {
    const [y, m, d] = cfg.firstDate.split('-').map(Number);
    if (slot.at < zonedToUtc({ y, m, d }, cfg.timezone)) return { due: false, reason: 'not-started', week: slot.week };
  }
  if (st.weeks[slot.week]) return { due: false, reason: 'done', week: slot.week, mark: st.weeks[slot.week] };
  return { due: true, reason: 'due', week: slot.week, at: slot.at, until: slot.until };
}

/** Record what happened to a week; keeps the newest KEEP_WEEK_MARKS marks and keepReports stored reports. */
export function markWeek(state, week, mark, { model = null, keepReports = 4 } = {}) {
  const st = loadReportState(state);
  st.weeks[week] = { ...(st.weeks[week] ?? {}), ...mark };
  for (const w of Object.keys(st.weeks).sort().slice(0, -KEEP_WEEK_MARKS)) delete st.weeks[w];
  if (model) st.reports[week] = model;
  for (const w of Object.keys(st.reports).sort().slice(0, -keepReports)) delete st.reports[w];
  st.last = Object.keys(st.weeks).sort().at(-1) ?? null;
  return st;
}

// ---------------------------------------------------------------- formatting

const two = (n) => String(n).padStart(2, '0');
export const fmtDate = (ms, tz) => {
  const z = zoned(ms, tz);
  return `${two(z.d)}.${two(z.m)}.${z.y}`;
};
export const fmtStamp = (ms, tz) => {
  const z = zoned(ms, tz);
  return `${two(z.d)}.${two(z.m)}., ${two(z.hh)}:${two(z.mm)}`;
};
export const fmtFull = (ms, tz) => {
  const z = zoned(ms, tz);
  return `${two(z.d)}.${two(z.m)}.${z.y}, ${two(z.hh)}:${two(z.mm)} Uhr`;
};
const isoDateDE = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
};
const iso = (min) => new Date(min * MIN).toISOString();

/** A short model name for a group of several products: the title without the group's own words, sizes and part numbers. */
export function shortModel(title, label, max = 40) {
  let t = cleanTitle(title).replace(/\([^)]*\)/g, ' ').replace(/,\s*(white|black|weiß|schwarz)\b.*$/i, '').replace(/,?\s*\bPCIe\b.*$/i, '');
  const words = String(label).replace(/[,()]/g, ' ').split(/\s+/).filter(Boolean);
  const drop = new Set(words.map((w) => w.toLowerCase()));
  words.forEach((w, i) => { if (/^\d+$/.test(w) && words[i + 1]) drop.add(`${w}${words[i + 1]}`.toLowerCase()); });
  const noise = /^(geforce|radeon|kit|nvme|\d+gb?|\d+tb)$/i;
  t = t.split(/\s+/).filter((w) => w && !drop.has(w.toLowerCase()) && !noise.test(w)).join(' ').trim();
  if (!t) t = cleanTitle(title);
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1).replace(/\s+\S*$/, '');
  return cut || t.slice(0, max);
}

const shortTitle = (it) => {
  const t = cleanTitle(it.title ?? it.productName ?? it.productKey).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length <= 40 ? t : t.slice(0, 41).replace(/\s+\S*$/, '');
};

// ---------------------------------------------------------------- the report model

/** Watch items for the report: one per shop and product, Amazon and excluded shops left out. */
export function reportItems(list, rc) {
  const seen = new Set();
  const out = [];
  for (const it of Array.isArray(list) ? list : list?.items ?? []) {
    if (!it?.productKey || !it.url) continue;
    const retailer = String(it.retailer ?? '').toLowerCase() || retailerFromUrl(it.url);
    if (isExcluded(retailer, it.url, rc.excludeRetailers)) continue;
    const id = `${retailer}:${it.productKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...it, retailer });
  }
  return out;
}

function retailerFromUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h.split('.').at(-2) ?? h;
  } catch {
    return '';
  }
}

/**
 * Build the report from the market log. Pure.
 * @param {object} o
 * @param {object} o.log        market:log
 * @param {object[]} o.items    watch items (reportItems), with retailer resolved the way the monitor does
 * @param {object} o.rc         resolved market-report.json
 * @param {object} o.cfg        ops.marketReport
 * @param {number} o.now        ms
 * @param {string} [o.week]     ISO week id, default the week of `now`
 * @param {(id:string)=>string} [o.shopName]
 */
export function buildReport({ log, items, rc, cfg, now, week = null, shopName = (id) => id, channelUrl = 'https://t.me/lagerfunk' }) {
  const L = loadLog(log);
  const tz = cfg.timezone;
  const nowMin = Math.floor(now / MIN);
  const windowFrom = nowMin - cfg.windowDays * 1440;
  const freshMin = cfg.freshHours * 60;
  const pool = items.filter((it) => !isExcluded(it.retailer, it.url, rc.excludeRetailers));
  const categories = [];
  for (const cat of rc.categories) {
    const members = pool.filter((it) => cat.re.test(it.productKey) || (it.category && it.category === cat.id));
    const byGroup = new Map(cat.groups.map((g) => [g.id, { def: g, members: [] }]));
    for (const it of members) {
      const def = cat.groups.find((g) => g.keys?.includes(it.productKey) || g.re?.test(it.productKey));
      if (def) byGroup.get(def.id).members.push(it);
      else {
        if (!byGroup.has(`auto:${it.productKey}`)) byGroup.set(`auto:${it.productKey}`, { def: { id: it.productKey, label: shortTitle(it), key: false, variants: false, auto: true }, members: [] });
        byGroup.get(`auto:${it.productKey}`).members.push(it);
      }
    }
    const withLog = (g) => g.members.map((it) => ({ it, e: L.items[`${it.retailer}:${it.productKey}`] })).filter((x) => x.e);
    const allEntries = [...byGroup.values()].flatMap(withLog);
    const since = allEntries.length ? Math.min(...allEntries.map((x) => x.e.f)) : null;
    const coveredMin = since === null ? 0 : nowMin - since;
    const enough = since !== null && coveredMin >= cfg.minDays * 1440;
    const from = since === null ? windowFrom : Math.max(windowFrom, since);
    const observedHours = Math.round((nowMin - from) / 60);
    const groups = [];
    for (const g of byGroup.values()) {
      if (!g.members.length) continue;
      const entries = withLog(g);
      const fresh = entries.filter((x) => x.e.s && nowMin - x.e.s.t <= freshMin);
      const offers = fresh.filter((x) => x.e.s.a === 1 && typeof x.e.s.p === 'number');
      const best = [...offers].sort((a, b) => a.e.s.p - b.e.s.p || b.e.s.t - a.e.s.t)[0] ?? null;
      const latest = fresh.length ? Math.max(...fresh.map((x) => x.e.s.t)) : null;
      const prices = g.members.map((it) => Number(it.listPrice)).filter((p) => Number.isFinite(p) && p > 0);
      const ref = prices.length ? Math.min(...prices) : null;
      const refType = ref !== null && g.members.some((it) => Number(it.listPrice) === ref && String(it.listPriceType ?? '').toLowerCase() === 'uvp') ? 'uvp' : null;
      const restockAt = entries.flatMap((x) => x.e.r.filter((t) => t >= from && t <= nowMin).map((t) => ({ t, retailer: x.it.retailer }))).sort((a, b) => a.t - b.t);
      const out = {
        id: g.def.id,
        label: g.def.label,
        key: g.def.key === true,
        auto: g.def.auto === true,
        status: best ? 'in_stock' : fresh.length ? 'out_of_stock' : entries.length ? 'stale' : 'no_data',
        price: best ? best.e.s.p / 100 : null,
        shop: best ? shopName(best.it.retailer) : null,
        retailer: best ? best.it.retailer : null,
        productKey: best ? best.it.productKey : null,
        model: best && g.def.variants ? shortModel(best.it.title ?? best.it.productName ?? best.it.productKey, g.def.label) : null,
        url: best ? best.it.url : null,
        at: best ? iso(best.e.s.t) : latest !== null ? iso(latest) : null,
        shopsInStock: new Set(offers.map((x) => x.it.retailer)).size,
        shopsChecked: new Set(fresh.map((x) => x.it.retailer)).size,
        listPrice: ref,
        listPriceType: refType,
        week: null,
        restocks: enough ? restockAt.length : null,
        lastRestock: enough && restockAt.length ? { at: iso(restockAt.at(-1).t), shop: shopName(restockAt.at(-1).retailer) } : null,
        delivery: null,
      };
      if (enough && out.key) {
        const ex = entries.map((x) => x.e);
        out.week = {
          from: iso(from),
          observedHours,
          hoursInStock: Math.floor(buyableMinutes(ex, from, nowMin) / 60),
          hoursAtList: ref === null ? null : Math.floor(buyableMinutes(ex, from, nowMin, Math.round(ref * 100)) / 60),
        };
      }
      if (cat.deliveryBefore) {
        const early = offers.filter((x) => x.e.s.d && x.e.s.d < cat.deliveryBefore).sort((a, b) => (a.e.s.d < b.e.s.d ? -1 : a.e.s.d > b.e.s.d ? 1 : a.e.s.p - b.e.s.p))[0];
        if (early) out.delivery = { date: early.e.s.d, assumed: early.e.s.da === 1, preorder: early.e.s.po === 1, shop: shopName(early.it.retailer), retailer: early.it.retailer, url: early.it.url, productKey: early.it.productKey, price: early.e.s.p / 100, at: iso(early.e.s.t) };
      }
      groups.push(out);
    }
    const restocks = enough ? groups.reduce((n, g) => n + g.restocks, 0) : null;
    const last = enough ? groups.filter((g) => g.lastRestock).sort((a, b) => (a.lastRestock.at < b.lastRestock.at ? 1 : -1))[0]?.lastRestock ?? null : null;
    categories.push({
      id: cat.id,
      label: cat.label,
      emoji: cat.emoji,
      coverage: { since: since === null ? null : iso(since), days: Math.floor((coveredMin / 1440) * 10) / 10, enough, minDays: cfg.minDays, windowDays: cfg.windowDays, from: iso(from), observedHours },
      restocks,
      lastRestock: last,
      deliveryBefore: cat.deliveryBefore,
      deliveryLabel: cat.deliveryLabel,
      groups,
    });
  }
  const wk = week ?? weekOf(now, tz);
  return {
    v: 1,
    kind: 'lagerfunk-marktbericht',
    week: wk,
    title: `Lagerfunk Marktbericht KW ${Number(wk.slice(-2))}/${wk.slice(0, 4)}`,
    generatedAt: new Date(now).toISOString(),
    timezone: tz,
    source: 'Eigene Messungen von Lagerfunk in deutschen Shops. Ohne Amazon und ohne Marktplatz-Händler.',
    channelUrl,
    categories,
  };
}

/** Does the report say anything current: at least one product group with a fresh reading? */
export function hasCurrentData(model) {
  return model.categories.some((c) => c.groups.some((g) => g.status === 'in_stock' || g.status === 'out_of_stock'));
}

// ---------------------------------------------------------------- compliance

/** Words and shapes no report may contain (visible text). Mirrors bot/src/pricing.js and the launch posts' list. */
export const BANNED = [
  [/%/, 'percent sign'],
  [/prozent/i, 'percent figure'],
  [/\bstatt\b/i, '"statt" reference price'],
  [/\bvorher\b/i, '"vorher" reference price'],
  [/\bspar(e|en|st|t)?\b|ersparnis/i, 'saving claim'],
  [/rabatt|reduziert|preissturz|schnäppchen|tiefstpreis|\bgünstiger\b|\bbilliger\b/i, 'discount wording'],
  [/sofort|garantiert/i, 'speed or guarantee claim'],
  [/[–—]/, 'en or em dash'],
];

/** Throws when the visible text breaks a rule. */
export function assertReportCompliant(text, { affiliate = false } = {}) {
  for (const [re, why] of BANNED) if (re.test(text)) throw new Error(`Compliance: ${why} in the market report: "${re.exec(text)[0]}"`);
  assertCompliant(text);
  const first = text.split('\n')[0].trim();
  if (affiliate && first !== 'Anzeige') throw new Error('Compliance: a report with an affiliate link must start with "Anzeige"');
  if (!affiliate && /^Anzeige/.test(first)) throw new Error('Compliance: "Anzeige" without an affiliate link');
  if (!text.includes(REQUIRED_LINE)) throw new Error('Compliance: the line about changing prices is missing');
}

const plain = (html) => String(html).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ---------------------------------------------------------------- Telegram

const kw = (week) => `KW ${Number(String(week).slice(-2))}`;

/** "Erst 2 Tage eigene Messdaten (seit 14.10.2026): Wochenwerte gibt es ab 3 Tagen." */
export function coverageNote(c, tz) {
  const days = Math.floor(c.coverage.days);
  const span = days >= 2 ? `${days} Tage` : days === 1 ? 'einen Tag' : 'wenige Stunden';
  return `Erst ${span} eigene Messdaten (seit ${fmtDate(Date.parse(c.coverage.since), tz)}): Wochenwerte gibt es ab ${c.coverage.minDays} Tagen.`;
}

/**
 * Telegram HTML (and Discord markdown). linkFor({ url, retailer, productKey }) -> { url, affiliate } | null builds the shop
 * link (affiliate only when the switch is on); without it the plain shop link is used.
 * Shrinks the number of lines per category until the post fits telegramMaxChars visible characters.
 */
export function renderTelegram(model, { cfg, linkFor = defaultLink, maxLines = cfg.maxLinesPerCategory } = {}) {
  for (let n = maxLines; n >= 1; n--) {
    for (const compact of [false, true]) {
      const r = renderTelegramOnce(model, { cfg, linkFor, maxLines: n, compact });
      if (r.length <= cfg.telegramMaxChars) return r;
    }
  }
  throw new Error(`market report does not fit into ${cfg.telegramMaxChars} characters`);
}

function defaultLink({ url }) {
  return url ? { url, affiliate: looksLikeAffiliateUrl(url) } : null;
}

function renderTelegramOnce(model, { cfg, linkFor, maxLines, compact }) {
  const tz = model.timezone;
  const now = Date.parse(model.generatedAt);
  const lines = [];
  let affiliate = false;
  const link = (g) => {
    if (!g.url) return null;
    const l = linkFor({ url: g.url, retailer: g.retailer, productKey: g.productKey });
    if (l?.affiliate) affiliate = true;
    return l?.url ? l : null;
  };
  const stamp = (isoAt) => `Stand ${fmtStamp(Date.parse(isoAt), tz)}`;
  lines.push(`📊 <b>Lagerfunk Marktbericht ${kw(model.week)}</b>`);
  lines.push(`Stand ${fmtFull(now, tz)}. Eigene Messungen in deutschen Shops, ohne Amazon und ohne Marktplatz-Händler.`);
  for (const c of model.categories) {
    const shown = c.groups.filter((g) => !g.auto && (g.status === 'in_stock' || (g.status === 'out_of_stock' && g.key)));
    if (!shown.length && !c.coverage.since) continue;
    lines.push('', `${c.emoji ? `${c.emoji} ` : ''}<b>${esc(c.label)}</b>`);
    if (!c.coverage.since) {
      lines.push('<i>Noch keine eigenen Messdaten.</i>');
      continue;
    }
    if (!c.coverage.enough) lines.push(`<i>${coverageNote(c, tz)}</i>`);
    for (const g of shown.slice(0, maxLines)) {
      if (g.status === 'in_stock') {
        const l = link(g);
        const name = l ? `<a href="${esc(l.url)}">${esc(g.label)}</a>` : esc(g.label);
        const model = g.model && !compact ? ` (${esc(g.model)})` : '';
        lines.push(`• ${name}: ab <b>${formatEuro(g.price)}</b> bei ${esc(g.shop)}${model}, ${stamp(g.at)}`);
      } else {
        lines.push(`• ${esc(g.label)}: bei keinem beobachteten Shop kaufbar, ${stamp(g.at)}`);
      }
    }
    if (shown.length > maxLines) lines.push(`<i>+ ${shown.length - maxLines} weitere Produktgruppen</i>`);
    if (c.coverage.enough) {
      const keyed = c.groups.filter((g) => g.week).slice(0, maxLines);
      const sinceLabel = c.coverage.observedHours >= c.coverage.windowDays * 24 - 1 ? `in den letzten ${c.coverage.windowDays} Tagen` : `seit ${fmtStamp(Date.parse(c.coverage.from), tz)}`;
      if (keyed.length) {
        lines.push(`Kaufbar ${sinceLabel}:`);
        for (const g of keyed) {
          const at = g.listPrice !== null ? ` zu höchstens ${formatEuro(g.listPrice)}${g.listPriceType === 'uvp' ? ' (UVP)' : ''}` : '';
          const h = g.listPrice !== null ? g.week.hoursAtList : g.week.hoursInStock;
          lines.push(`• ${esc(g.label)}: ${h} von ${g.week.observedHours} Std.${at}`);
        }
      }
      if (c.restocks > 0) {
        const top = c.groups.filter((g) => g.restocks > 0).sort((a, b) => b.restocks - a.restocks).slice(0, compact ? 2 : 3);
        const last = c.lastRestock;
        lines.push(`Restocks ${sinceLabel}: ${c.restocks} (${top.map((g) => `${esc(g.label)} ${g.restocks}`).join(', ')}${c.groups.filter((g) => g.restocks > 0).length > top.length ? ', ...' : ''}), zuletzt ${fmtStamp(Date.parse(last.at), tz)} bei ${esc(last.shop)}`);
      } else {
        lines.push(`Restocks ${sinceLabel}: keine erkannt`);
      }
    }
    if (c.deliveryBefore) {
      const ds = c.groups.filter((g) => g.delivery).slice(0, maxLines);
      const label = `Lieferung vor ${c.deliveryLabel ? `${esc(c.deliveryLabel)} ` : ''}(${isoDateDE(c.deliveryBefore)})`;
      if (!ds.length) lines.push(`🚚 ${label}: bei keinem beobachteten Shop, Stand ${fmtStamp(now, tz)}`);
      else {
        lines.push(`🚚 ${label}:`);
        for (const g of ds) {
          const d = g.delivery;
          lines.push(`• ${esc(g.label)} bei ${esc(d.shop)}: ${d.preorder ? 'Vorbestellung, ' : ''}Lieferung ${d.assumed ? 'ca. ' : 'ab '}${isoDateDE(d.date)}, ${stamp(d.at)}`);
        }
      }
    }
  }
  lines.push('', `<i>${REQUIRED_LINE} Versandkosten können hinzukommen. Std. zählt nur Zeit, in der wir das Produkt bei mindestens einem Shop kaufbar gesehen haben. Kein Kaufversprechen.</i>`);
  const ch = String(model.channelUrl || '').replace(/^https?:\/\//, '');
  if (ch) lines.push(`📡 Restocks und Preisalarme: ${esc(ch)}`);
  if (affiliate) lines.unshift('<b>Anzeige</b>');
  const html = lines.join('\n');
  const text = plain(html);
  assertReportCompliant(text, { affiliate });
  return { html, discord: htmlToDiscord(html), affiliate, length: visibleLength(html), text, buttons: null, previewUrl: null, photo: null };
}

/** Telegram HTML -> Discord markdown (bold, italics, links). */
export function htmlToDiscord(html) {
  return String(html)
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, (m, u, t) => `[${t}](<${u.replace(/&amp;/g, '&')}>)`)
    .replace(/<\/?b>/g, '**')
    .replace(/<\/?i>/g, '*')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------- site page and JSON

/** The channel link for the site, with UTM parameters of this issue. */
export function channelLink(base, week, utm) {
  const u = new URL(base || 'https://t.me/lagerfunk');
  u.searchParams.set('utm_source', utm.source);
  u.searchParams.set('utm_medium', utm.medium);
  u.searchParams.set('utm_campaign', `marktbericht-${weekFile(week)}`);
  return u.toString();
}

const CSS = `:root{--blue:#1F35FF;--signal:#FF6B2C;--paper:#F1F2F7;--surface:#FFFFFF;--ink:#0C1233;--ink-2:#4A5175;--rule:#D6D9E6;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#070B24;--surface:#0E1438;--ink:#E9EBF7;--ink-2:#A3A9CB;--rule:#272E61;--blue:#8C98FF;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}h1{font-size:1.7rem;line-height:1.2;margin:0 0 6px}h2{font-size:1.2rem;margin:0 0 10px}
.ad{display:inline-block;font-weight:700;font-size:.85rem;letter-spacing:.04em;text-transform:uppercase;color:var(--signal);margin-bottom:8px}
.meta,.note{color:var(--ink-2);font-size:.92rem}section{background:var(--surface);border:1px solid var(--rule);border-radius:14px;padding:16px;margin:18px 0}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.95rem}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-2)}td.num{white-space:nowrap;font-variant-numeric:tabular-nums}
ul{padding-left:20px;margin:8px 0}a{color:var(--blue)}.cta{display:inline-block;margin-top:8px;padding:12px 20px;border-radius:999px;background:var(--blue);color:#fff;font-weight:700;text-decoration:none}
@media (prefers-color-scheme:dark){.cta{color:#070B24}}`;

/** A small, self-contained HTML page of the report (no external files). */
export function renderHtml(model, { linkFor = defaultLink, channelUrl = model.channelUrl } = {}) {
  const tz = model.timezone;
  const now = Date.parse(model.generatedAt);
  let affiliate = false;
  const a = (g, text) => {
    const l = g.url ? linkFor({ url: g.url, retailer: g.retailer, productKey: g.productKey }) : null;
    if (!l?.url) return esc(text);
    if (l.affiliate) affiliate = true;
    return `<a href="${esc(l.url)}" rel="${l.affiliate ? 'sponsored nofollow noopener' : 'nofollow noopener'}">${esc(text)}</a>`;
  };
  const st = (isoAt) => (isoAt ? fmtStamp(Date.parse(isoAt), tz) : '');
  const body = [];
  for (const c of model.categories) {
    const rows = c.groups.filter((g) => g.status !== 'no_data');
    if (!rows.length && !c.coverage.since) continue;
    const s = [`<section><h2>${c.emoji ? `${c.emoji} ` : ''}${esc(c.label)}</h2>`];
    if (!c.coverage.since) s.push('<p class="note">Noch keine eigenen Messdaten.</p>');
    else if (!c.coverage.enough) s.push(`<p class="note">${esc(coverageNote(c, tz))}</p>`);
    s.push('<div class="scroll"><table><thead><tr><th>Produktgruppe</th><th>Preis ab</th><th>Shop</th><th>Modell</th><th>Stand</th></tr></thead><tbody>');
    for (const g of rows) {
      if (g.status === 'in_stock') s.push(`<tr><td>${a(g, g.label)}</td><td class="num">${formatEuro(g.price)}</td><td>${esc(g.shop)}</td><td>${esc(g.model ?? '')}</td><td class="num">${st(g.at)}</td></tr>`);
      else s.push(`<tr><td>${esc(g.label)}</td><td>${g.status === 'out_of_stock' ? 'nicht kaufbar' : 'keine aktuellen Daten'}</td><td></td><td></td><td class="num">${st(g.at)}</td></tr>`);
    }
    s.push('</tbody></table></div>');
    if (c.coverage.enough) {
      const keyed = c.groups.filter((g) => g.week);
      const from = fmtStamp(Date.parse(c.coverage.from), tz);
      if (keyed.length) {
        s.push(`<p><b>Kaufbar seit ${from}</b> (${c.coverage.observedHours} Std. beobachtet):</p><ul>`);
        for (const g of keyed) {
          const at = g.listPrice !== null ? ` zu höchstens ${formatEuro(g.listPrice)}${g.listPriceType === 'uvp' ? ' (UVP)' : ''}` : '';
          s.push(`<li>${esc(g.label)}: ${g.listPrice !== null ? g.week.hoursAtList : g.week.hoursInStock} Std.${at}</li>`);
        }
        s.push('</ul>');
      }
      s.push(c.restocks > 0
        ? `<p><b>Restocks seit ${from}:</b> ${c.restocks} (${c.groups.filter((g) => g.restocks > 0).map((g) => `${esc(g.label)} ${g.restocks}`).join(', ')}), zuletzt ${st(c.lastRestock.at)} bei ${esc(c.lastRestock.shop)}.</p>`
        : `<p><b>Restocks seit ${from}:</b> keine erkannt.</p>`);
    }
    if (c.deliveryBefore) {
      const ds = c.groups.filter((g) => g.delivery);
      s.push(`<p><b>🚚 Lieferung vor ${c.deliveryLabel ? `${esc(c.deliveryLabel)} ` : ''}(${isoDateDE(c.deliveryBefore)}):</b>${ds.length ? '' : ` bei keinem beobachteten Shop, Stand ${fmtStamp(now, tz)}.`}</p>`);
      if (ds.length) s.push(`<ul>${ds.map((g) => `<li>${a({ ...g, url: g.delivery.url, retailer: g.delivery.retailer, productKey: g.delivery.productKey }, g.label)} bei ${esc(g.delivery.shop)}: ${g.delivery.preorder ? 'Vorbestellung, ' : ''}Lieferung ${g.delivery.assumed ? 'ca.' : 'ab'} ${isoDateDE(g.delivery.date)}, Stand ${st(g.delivery.at)}</li>`).join('')}</ul>`);
    }
    s.push('</section>');
    body.push(s.join('\n'));
  }
  const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(model.title)}</title>
<meta name="description" content="${esc(`${model.title}: Preise mit Stand, kaufbare Stunden und Restocks für PS5 Pro, Konsolen, Grafikkarten, RAM und SSDs aus eigenen Messungen.`)}">
<style>${CSS}</style>
</head>
<body>
<main>
${affiliate ? '<div class="ad">Anzeige</div>\n' : ''}<h1>${esc(model.title)}</h1>
<p class="meta">Stand ${fmtFull(now, tz)}. ${esc(model.source)}</p>
${body.join('\n')}
<p class="note">${esc(REQUIRED_LINE)} Versandkosten können hinzukommen. Std. zählt nur Zeit, in der wir das Produkt bei mindestens einem Shop kaufbar gesehen haben: Zwischen zwei Prüfungen kann sich etwas geändert haben, die Werte sind Mindestwerte. Kein Kaufversprechen.${affiliate ? ' Links mit dem Hinweis Anzeige sind Affiliate-Links: Kaufst du darüber, erhalten wir eventuell eine Provision, für dich ändert sich der Preis nicht.' : ''}</p>
<p><a class="cta" href="${esc(channelUrl)}">Restocks und Preisalarme auf Telegram</a></p>
</main>
</body>
</html>
`;
  assertReportCompliant(`${affiliate ? 'Anzeige\n' : ''}${plain(html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<head>[\s\S]*?<\/head>/, '').replace('<div class="ad">Anzeige</div>', ''))}`, { affiliate });
  return { html, affiliate };
}

/** The JSON for the site: the model plus the UTM channel link and the fixed texts. */
export function renderJson(model, { channelUrl }) {
  return `${JSON.stringify({ ...model, channelUrl, notes: [REQUIRED_LINE, 'Versandkosten können hinzukommen.', 'Kein Kaufversprechen.'] }, null, 1)}\n`;
}

/** Write deploy/out/report-YYYY-WW.html and .json. Returns the two paths. */
export function writeReportFiles({ outDir, model, rc, linkFor = defaultLink, preview = false }) {
  const url = channelLink(rc.channelUrl || model.channelUrl, model.week, rc.utm);
  const page = renderHtml(model, { linkFor, channelUrl: url });
  mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `report-${weekFile(model.week)}`);
  writeFileSync(`${base}.html`, page.html);
  writeFileSync(`${base}.json`, renderJson({ ...model, ...(preview ? { preview: true } : {}) }, { channelUrl: url }));
  return { html: `${base}.html`, json: `${base}.json`, channelUrl: url, affiliate: page.affiliate };
}
