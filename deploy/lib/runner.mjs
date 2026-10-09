// One run of the Lagerfunk monitor + bot, built for a scheduled GitHub Actions job (also runs on a laptop).
//
//   node deploy/run.mjs --mode watch     shops that can be fetched without a proxy (every 10 minutes)
//   node deploy/run.mjs --mode feeds     affiliate product feeds: Proshop, Cyberport, computeruniverse, Galaxus (hourly)
//   node deploy/run.mjs --mode all       both (manual runs)
//   node deploy/run.mjs --mode auto      watch, and the feeds too when the last feeds run is an hour old (what the chain loop runs)
//   node deploy/run.mjs --mode status    print what the profile switches on and off, no network, no state
//
// Order of work: read state, check, guard (circuit breakers, price sanity, surge, dedupe), checkpoint, post through
// the bot, write state back. The state is written as one commit on the "state" branch together with the activity line
// and status.json (which carries the heartbeat the watchdog reads). When there is something to post, the state is
// saved once BEFORE posting too (the checkpoint): if the final save then fails, the next run starts from the
// checkpoint, sees the products as already announced and never posts them twice.
// Every run also adds its readings to market:log (deploy/lib/marketlog.mjs); once a week (Friday 18:00 Berlin, marketReport in
// breakers.json) the run whose slot is open builds the Marktbericht from it (deploy/lib/marketreport.mjs), marks the ISO week in
// market:report inside the checkpoint and posts it with the alerts.
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMonitor } from '../../monitor/src/monitor.js';
import { resolveProfile } from '../../monitor/src/profile.js';
import { feedsFromEnv } from '../../monitor/src/feeds/index.js';
import { historyKey } from '../../monitor/src/history.js';
import { stateKey } from '../../monitor/src/rules.js';
import { createEngine } from '../../bot/src/engine.js';
import { loadConfig } from '../../bot/src/config.js';
import { resolveRetailer, buildLink } from '../../bot/src/affiliate.js';
import { guardLink } from '../../bot/src/linkcheck.js';
import { MARKET_LOG_KEY, recordChecks } from './marketlog.mjs';
import { MARKET_REPORT_KEY, loadReportConfig, reportPlan, markWeek, buildReport, renderTelegram, reportItems, writeReportFiles, hasCurrentData } from './marketreport.mjs';
import { createStateStore, serializeState, parseState } from './store.mjs';
import { collectSecrets, scrub } from './secrets.mjs';
import { buildActivity, appendActivity, parseActivity, buildStatus } from './activity.mjs';
import { createGit, fetchState, pushState } from './gitstate.mjs';
import { loadOpsConfig } from './config.mjs';
import { feedsDue } from './chain.mjs';
import { createJsonLog, personalValues, scrubPersonal } from './log.mjs';
import { createAdmin, loadAdminState } from './admin.mjs';
import { resolveChannel } from './stage.mjs';
import { readBranch, OPS_BRANCH } from './opsbranch.mjs';
import {
  BREAKERS_KEY, LEDGER_KEY, HELD_KEY, loadBreakers, retailerPlan, pickProbe, collectRetailerResults, updateRetailers, openRetailers,
  surgeCheck, priceVerdict, telegramPlan, telegramAfterProbe, telegramUpdate, dedupe, ledgerRecord, ledgerMarkSent, ledgerPrune,
  holdAlerts, releasable,
} from './breakers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const MODES = ['watch', 'feeds', 'all', 'auto', 'status'];
const TICK_MS = 10 * 60000;
const MAX_SINCE_MS = 2 * 3600000;
export const IDLE_WARN_DAYS = 45; // GitHub switches scheduled workflows off in a public repo after 60 days without activity
export const ADMIN_KEY = 'runner:admin';
export const SILENT_ONCE_KEY = 'runner:silentOnce';
const STALE_AFTER_MS = 3600000; // the bot refuses alerts older than this (STALE_AFTER_SEC default)

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

export function parseArgs(argv = [], env = {}, root = ROOT) {
  const has = (n) => argv.includes(n);
  const val = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const mode = (val('--mode') ?? env.MODE ?? 'watch').toLowerCase().trim();
  if (!MODES.includes(mode)) throw new Error(`unknown mode "${mode}". Use one of: ${MODES.join(', ')}`);
  return {
    mode,
    dryRun: has('--dry-run') || truthy(env.DRY_RUN),
    silent: has('--silent') || truthy(env.SILENT),
    noPush: has('--no-push') || truthy(env.NO_PUSH),
    force: has('--force') || truthy(env.FORCE),
    releaseHeld: has('--release-held') || truthy(env.RELEASE_HELD),
    pause: truthy(env.LAGERFUNK_PAUSE),
    stateDir: val('--state-dir') ?? env.STATE_DIR ?? null,
    watchlistPath: path.resolve(root, val('--watchlist') ?? env.WATCHLIST_FILE ?? 'watchlist.json'),
    outDir: path.resolve(root, val('--out') ?? env.OUT_DIR ?? 'deploy/out'),
    deadlineMs: Number(env.RUN_DEADLINE_MS) || 6 * 60000,
  };
}

/** Brand defaults from brand.json (the website's single source of truth), unless the environment sets them. */
export function botEnv(env, brand) {
  const out = { ...env };
  const dflt = {
    BRAND: brand?.brandName,
    CHANNEL_URL: brand?.telegramUrl,
    IMPRESSUM_URL: brand?.siteUrl ? `${brand.siteUrl}/impressum` : undefined,
    FREE_CHAT_ID: brand?.telegramHandle ? `@${brand.telegramHandle}` : undefined,
  };
  for (const [k, v] of Object.entries(dflt)) if (v && !out[k]) out[k] = v;
  return out;
}

/** Local directory backend: same shape as the git one. For laptops, tests and --state-dir. */
export function dirBackend(dir) {
  const files = ['state.json', 'state.prev.json', 'activity.jsonl', 'status.json'];
  return {
    kind: 'dir',
    async load() {
      if (!existsSync(path.join(dir, 'state.json'))) return { status: 'missing', token: null, files: {} };
      return { status: 'ok', token: null, files: Object.fromEntries(files.map((f) => [f, existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), 'utf8') : null])) };
    },
    async save(out) {
      mkdirSync(dir, { recursive: true });
      for (const [f, text] of Object.entries(out)) if (text !== null && text !== undefined) writeFileSync(path.join(dir, f), text);
    },
  };
}

/** Git backend: the "state" branch of the checkout in `cwd`. */
export function gitBackend({ git, sleep } = {}) {
  return {
    kind: 'git',
    async load() {
      const r = await fetchState({ git });
      return { status: r.status, token: r.sha, files: r.files };
    },
    async save(out, { token, message }) {
      return pushState({ git, files: out, expectSha: token, message, sleep });
    },
  };
}

/** Days since the newest commit of the checked-out branch, or null when unknown. */
export async function repoIdleDays(git, nowMs) {
  try {
    const sec = Number((await git(['log', '-1', '--format=%ct', 'HEAD'])).trim());
    return Number.isFinite(sec) && sec > 0 ? Math.max(0, Math.floor((nowMs - sec * 1000) / 86400000)) : null;
  } catch {
    return null;
  }
}

/** Days since a unix timestamp (seconds), e.g. MAIN_COMMIT_TS: the workflow records main's newest commit before it
 * switches to the last-known-good tag, so the 60-day clock is measured on main, not on the tag. */
export function idleDaysFrom(tsSec, nowMs) {
  const sec = Number(tsSec);
  return Number.isFinite(sec) && sec > 0 ? Math.max(0, Math.floor((nowMs - sec * 1000) / 86400000)) : null;
}

function clampSince(last, t0) {
  if (!Number.isFinite(last) || last <= 0) return t0 - TICK_MS;
  return Math.max(last, t0 - MAX_SINCE_MS);
}

export function readBrand(root) {
  for (const f of ['brand.json', 'site/brand.json']) if (existsSync(path.join(root, f))) return JSON.parse(readFileSync(path.join(root, f), 'utf8'));
  return null;
}

/** Expected affiliate ids for the link check, from monitor/config/feeds.json (public advertiser and programme ids). */
export function linkExpectations(root, env = {}) {
  const out = { awinMids: {}, tdPrograms: {}, tdSiteId: env.TRADEDOUBLER_SITE_ID || null };
  try {
    const f = JSON.parse(readFileSync(path.join(root, 'monitor/config/feeds.json'), 'utf8'));
    for (const [id, c] of Object.entries(f.feeds ?? {})) {
      if (c.network === 'awin' && c.advertiserId) out.awinMids[id] = c.advertiserId;
      if (c.network === 'tradedoubler' && c.programId) out.tdPrograms[id] = c.programId;
    }
  } catch {
    /* no feeds config: the link check then uses AWIN_MIDS only */
  }
  return out;
}

/** Shop links for the market report, built and checked exactly like the alert links (affiliate only when the switch is on). */
export function reportLinkFor(botCfg) {
  return ({ url, retailer }) => {
    if (!url) return null;
    const r = resolveRetailer({ retailer, url }, botCfg);
    return guardLink(buildLink(url, r, botCfg), { alert: { url, shopUrl: url }, retailer: r, cfg: botCfg });
  };
}

/**
 * The weekly market report, if one is due now and not yet handled for its ISO week: built from market:log, rendered and
 * checked. Returns null when nothing is due. A report that cannot be built raises an admin alert and is tried again next
 * cycle (the week stays unmarked).
 */
export async function prepareMarketReport({ store, now, ops, root, items, botCfg, brand, note = () => {}, jlog = null, admin = null }) {
  const plan = reportPlan(now, ops.marketReport, await store.get(MARKET_REPORT_KEY));
  if (!plan.due) return null;
  try {
    const rc = loadReportConfig({ root });
    const linkFor = reportLinkFor(botCfg);
    const model = buildReport({
      log: await store.get(MARKET_LOG_KEY), items: reportItems(items, rc), rc, cfg: ops.marketReport, now, week: plan.week,
      shopName: (id) => resolveRetailer({ retailer: id }, botCfg).name, channelUrl: rc.channelUrl || brand?.telegramUrl || 'https://t.me/lagerfunk',
    });
    if (!hasCurrentData(model)) {
      // nothing read yet (a fresh state, every shop blocked): no empty report, the next cycle of the slot tries again
      note('notice', `market report ${plan.week} waits: no current readings in market:log yet`);
      return null;
    }
    const post = renderTelegram(model, { cfg: ops.marketReport, linkFor });
    jlog?.info('report.built', { week: plan.week, chars: post.length, affiliate: post.affiliate });
    return { week: plan.week, until: plan.until, id: `marktbericht:${plan.week}`, post, model, rc, linkFor };
  } catch (e) {
    note('error', `market report ${plan.week} not built: ${e.message}`);
    jlog?.error('report.failed', { week: plan.week, error: e.message });
    admin?.raise(`report:${plan.week}`, `[ALERT] The weekly market report ${plan.week} could not be built: ${e.message.slice(0, 300)}\nNothing was posted for it. The runner tries again every cycle while the slot is open. Preview: node deploy/ops.mjs report --dry-run. RUNBOOK: weekly market report.`);
    return null;
  }
}

/**
 * @param {object} opts  everything injectable for tests: env, argv, fetch, now, sleep, backend, git, root, out, jitterMs,
 *                       clock (the bot's), opsConfig (thresholds instead of deploy/config/breakers.json)
 * @returns {Promise<{ ok: boolean, activity: object|null, alerts: object[], bot: object|null, files: object, error?: Error }>}
 */
export async function runOnce(opts = {}) {
  const env = opts.env ?? process.env;
  const root = opts.root ?? ROOT;
  const cfg = parseArgs(opts.argv ?? [], env, root);
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const personal = personalValues(env);
  const rawOut = opts.out ?? ((line) => console.log(line));
  const out = (line) => rawOut(scrubPersonal(line, personal));
  const t0 = now();
  const notes = [];
  const note = (level, msg) => {
    notes.push(`${level}: ${msg}`);
    out(env.GITHUB_ACTIONS ? `::${level}::${msg}` : `${level.toUpperCase()}: ${msg}`);
  };
  const log = { warn: (m) => out(`warn ${m}`), error: (m) => out(`error ${m}`), log: () => {} };

  const profile = resolveProfile(env.PROFILE);
  const brand = readBrand(root);
  const watchlist = JSON.parse(readFileSync(cfg.watchlistPath, 'utf8'));
  const feeds = feedsFromEnv(env);
  const secrets = collectSecrets(env);

  // status: no network, no state
  if (cfg.mode === 'status') {
    const monitor = createMonitor({ store: createStateStore(), watchlist, profile, feeds, now, log });
    const st = monitor.status();
    out(`Profile ${st.profile.name} (proxy: ${st.profile.proxy}): ${st.active} items on, ${st.disabled} off`);
    for (const r of st.retailers) out(`  ${r.retailer.padEnd(18)} ${r.source ? `ON  via ${r.source}` : 'OFF'.padEnd(11)} ${String(r.items).padStart(3)} items${r.reason ? `  ${r.reason}` : ''}`);
    out(`Feeds configured: ${st.feeds.map((f) => `${f.retailer} (${f.format})`).join(', ') || 'none'}`);
    return { ok: true, activity: null, alerts: [], bot: null, files: {}, status: st };
  }

  // Bad configuration fails here, before any state is read or written.
  const ops = opts.opsConfig ?? loadOpsConfig({ root });
  const channel = resolveChannel(env);
  const logBase = { run: env.GITHUB_RUN_ID ?? null, mode: cfg.mode };
  const jlog = createJsonLog({ out, secrets, personal, base: logBase, now });

  // Posting without a bot token would consume the state transitions and lose the alerts. Fail before touching anything.
  const posting = !cfg.dryRun && !cfg.silent;
  if (posting && !env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set. Add it as a repository secret, or run with SILENT=1 or DRY_RUN=1.');
  const saving = !cfg.dryRun && !cfg.noPush;
  jlog.info('run.start', { profile: profile.name, channel: channel.channel, dryRun: cfg.dryRun, silent: cfg.silent, code: env.CODE_SHA ?? null });

  // ---------- state ----------
  const git = opts.git ?? createGit({ cwd: root, env });
  const backend = opts.backend ?? (cfg.stateDir ? dirBackend(path.resolve(root, cfg.stateDir)) : gitBackend({ git, sleep }));
  const loaded = await backend.load();
  let token = loaded.token;
  let entries = {};
  let reset = false;
  let restoredFromPrev = false;
  if (loaded.status === 'ok') {
    let parsed = parseState(loaded.files['state.json']);
    if (!parsed.ok && loaded.files['state.prev.json']) {
      parsed = parseState(loaded.files['state.prev.json']);
      restoredFromPrev = parsed.ok;
      if (parsed.ok) note('error', 'state.json was unreadable: restored state.prev.json. Posting is paused for this run so nothing is repeated.');
    }
    if (parsed.ok) entries = parsed.entries;
    else {
      reset = true;
      note('error', 'state.json and state.prev.json are unreadable: starting empty. Posting is paused for this run so nothing is repeated.');
    }
  } else {
    note('notice', 'no state yet: first run');
  }
  let silent = cfg.silent || reset || restoredFromPrev;
  const idleDays = env.MAIN_COMMIT_TS ? idleDaysFrom(env.MAIN_COMMIT_TS, t0) : env.GITHUB_ACTIONS === 'true' || opts.git ? await repoIdleDays(git, t0) : null;
  if (idleDays !== null && idleDays >= IDLE_WARN_DAYS) note('warning', `the repository has had no commit for ${idleDays} days. GitHub switches scheduled jobs off after 60 days without activity. Commit any small change (for example a blank line in README.md) to reset the clock.`);

  const store = createStateStore({ entries, now });
  const meta = (await store.get('runner:meta')) ?? { runs: 0, firstRunAt: new Date(t0).toISOString(), lastTick: {} };
  meta.lastTick ??= {};
  if (cfg.mode === 'auto') {
    // The chain loop runs every cycle as "auto": the feeds are due once an hour (the state remembers when they last ran).
    const due = feedsDue({ lastFeedsAt: meta.lastTick.feeds, now: t0, everyMinutes: ops.chain.feedsEveryMinutes, slackMinutes: ops.chain.feedsSlackMinutes });
    cfg.mode = due ? 'all' : 'watch';
    logBase.mode = cfg.mode;
    jlog.info('run.mode', { requested: 'auto', feedsDue: due });
  }
  const silentOnce = await store.get(SILENT_ONCE_KEY);
  if (silentOnce) {
    silent = true;
    note('notice', `first run after a state restore${silentOnce.from ? ` (backup ${silentOnce.from})` : ''}: learning only, nothing is posted, so nothing from before the backup is announced again`);
    await store.delete(SILENT_ONCE_KEY);
  }
  if (posting && !channel.posting) {
    silent = true;
    note('warning', channel.reason);
  }

  // ---------- safety state: breakers, post ledger, held posts, admin alerts ----------
  const breakers = loadBreakers(await store.get(BREAKERS_KEY));
  const ledger = ledgerPrune((await store.get(LEDGER_KEY)) ?? {}, t0, ops.dedupe.keepHours);
  let held = (await store.get(HELD_KEY)) ?? [];
  const adminState = loadAdminState(await store.get(ADMIN_KEY));
  const fetchImpl = opts.fetch ?? globalThis.fetch?.bind(globalThis);
  const admin = createAdmin({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_ADMIN_CHAT_ID, apiBase: env.TELEGRAM_API_BASE || undefined, fetch: fetchImpl, now, state: adminState, cfg: ops, label: `Lagerfunk${channel.channel === 'staging' ? ' (staging)' : ''}` });
  const events = [];
  let authTrip = false;
  const onEvent = (breaker, ev) => {
    if (!ev) return;
    const who = ev.retailer ?? ev.product ?? ev.kind ?? '';
    events.push(`${ev.type}:${breaker}${who ? `:${who}` : ''}`);
    const fields = { breaker, ...ev };
    if (ev.type === 'recover' || ev.type === 'lifted') jlog.info('breaker.recover', fields);
    else jlog.warn(`breaker.${ev.type}`, fields);
    if (breaker === 'retailer' && ev.type === 'trip') {
      note('warning', `breaker: ${ev.retailer} paused after ${ev.failures} failed checks (${ev.error}) until ${ev.openUntil}`);
      admin.raise(`trip:retailer:${ev.retailer}`, `[ALERT] Shop ${ev.retailer} paused after ${ev.failures} failed checks in a row (${ev.error}). Next probe ${hhmm(Date.parse(ev.openUntil))} UTC.\nDiagnosis: ${ev.diagnose}`);
    } else if (breaker === 'retailer' && ev.type === 'reopen') {
      if (ev.trips === 4) admin.raise(`escalate:retailer:${ev.retailer}`, `[ALERT] Shop ${ev.retailer} still failing after ${ev.trips - 1} probes (${ev.error}). Paused until ${hhmm(Date.parse(ev.openUntil))} UTC.\nDiagnosis: ${ev.diagnose}`);
    } else if (breaker === 'retailer' && ev.type === 'recover') {
      note('notice', `breaker: ${ev.retailer} is back`);
      admin.raise(`recover:retailer:${ev.retailer}:${t0}`, `[OK] Shop ${ev.retailer} answers again${ev.downMinutes !== null ? ` after ${ev.downMinutes} min` : ''}. Checks resumed.`, { severity: 'info' });
    } else if (breaker === 'surge') {
      note('warning', `breaker: ${ev.total} products flipped to in stock in one run. ${ev.held} post(s) held`);
      admin.raise(`trip:surge:${Object.keys(ev.perRetailer).sort().join(',')}`, `[ALERT] ${ev.total} products flipped to in stock in one run (${Object.entries(ev.perRetailer).map(([r, n]) => `${r} ${n}`).join(', ')}). ${ev.held} post(s) held, those shops stay held until ${hhmm(Date.parse(ev.holdUntil))} UTC.\nDiagnosis: ${ev.diagnose}`, { severity: 'critical' });
    } else if (breaker === 'price' && ev.type === 'trip') {
      note('warning', `price check: ${ev.product} ${ev.reason} (${ev.price} vs reference ${ev.reference} from ${ev.source}): held, kept out of the price history`);
      admin.raise(`trip:price:${ev.product}`, `[ALERT] Price for ${ev.product} looks wrong: ${ev.price} EUR against ${ev.reference ?? '?'} EUR (${ev.source ?? 'no reference'}). The post is held and the reading is kept out of the 30-day history.\nDiagnosis: usually a parser picked up the wrong number (accessory, monthly rate, bundle). If the price is real, run the workflow with release_held within the hour. RUNBOOK: false alert posted.`);
    } else if (breaker === 'price' && ev.type === 'lifted') {
      admin.raise(`lift:price:${ev.product}:${t0}`, `[OK] Price for ${ev.product} is plausible again (${ev.price} EUR).`, { severity: 'info' });
    } else if (breaker === 'telegram' && ev.type === 'trip') {
      if (ev.kind === 'auth') authTrip = true;
      note(ev.kind === 'auth' ? 'error' : 'warning', `breaker: Telegram ${ev.kind}: ${ev.error ?? ''} Posting paused until ${ev.openUntil}`);
      admin.raise(`trip:telegram:${ev.kind}`, `[ALERT] Telegram breaker open (${ev.kind}): ${ev.error ?? ''}\nNew posts wait in the queue and nothing is resent early; a post older than an hour is dropped as stale. Next probe ${hhmm(Date.parse(ev.openUntil))} UTC.\nDiagnosis: ${ev.diagnose}`, { severity: ev.kind === 'auth' ? 'critical' : 'warn' });
    } else if (breaker === 'telegram' && ev.type === 'recover') {
      note('notice', 'breaker: Telegram is back, posting resumed');
      admin.raise(`recover:telegram:${t0}`, `[OK] Telegram works again${ev.downMinutes !== null ? ` after ${ev.downMinutes} min` : ''}. Posting resumed.`, { severity: 'info' });
    }
  };

  const plan = retailerPlan(breakers, t0);
  if (plan.skip.size) note('notice', `paused by the circuit breaker: ${[...plan.skip].join(', ')}`);

  // ---------- check ----------
  const monitor = createMonitor({
    store,
    watchlist,
    fetch: opts.fetch,
    now,
    profile,
    feeds,
    proxy: null,
    options: env.SHIPS_BY ? { shipsBy: env.SHIPS_BY } : {},
    // A runner with a history only learns an item it has never seen: adding a watchlist row (RAM, SSD, ...) that happens to be in
    // stock must not post "wieder da" for it, and twenty such rows must not trip the surge breaker. A brand-new state keeps the old
    // behaviour (the first real run is started silent by hand).
    learnNew: Object.keys(entries).some((k) => k.startsWith('state:')),
    jitterMs: opts.jitterMs ?? 1500,
    concurrency: 6,
    timeoutMs: 20000,
    sleep,
    log,
  });
  const deadlineAt = t0 + cfg.deadlineMs;
  const scrape = { checks: [], alerts: [] };
  const fed = { checks: [], alerts: [], feeds: [] };
  let error = null;
  try {
    if (cfg.mode === 'watch' || cfg.mode === 'all') {
      // Open shops sit out. Half-open shops get exactly one request: the probe below.
      const r = await monitor.tick({ tickMs: TICK_MS, since: clampSince(meta.lastTick.watch, t0), source: 'scrape', skip: new Set([...plan.skip, ...plan.probe]) });
      scrape.checks.push(...r.checks);
      scrape.alerts.push(...r.alerts);
      for (const rid of plan.probe) {
        const item = pickProbe(monitor.items, rid, breakers);
        if (!item) continue; // a feed shop is probed by its next feed download
        const p = await monitor.checkItem(item);
        jlog.info('breaker.probe', { breaker: 'retailer', retailer: rid, productKey: item.productKey, ok: p.check.ok, error: p.check.error });
        scrape.checks.push(p.check);
        if (p.alert) scrape.alerts.push(p.alert);
      }
      meta.lastTick.watch = t0;
    }
    if (cfg.mode === 'feeds' || cfg.mode === 'all') {
      const retailers = [...new Set(monitor.items.filter((i) => i._source === 'feed').map((i) => i.retailer))];
      for (const retailer of retailers) {
        if (plan.skip.has(retailer)) {
          fed.feeds.push({ retailer, status: 'skipped', reason: 'breaker', rows: 0, matched: 0, items: 0, bytes: 0, ms: 0 });
          continue;
        }
        const remainingMs = deadlineAt - now();
        if (remainingMs < 20000) {
          fed.feeds.push({ retailer, status: 'skipped', reason: 'deadline', rows: 0, matched: 0, items: 0, bytes: 0, ms: 0 });
          note('warning', `feed ${retailer} skipped: the run's time budget is used up`);
          continue;
        }
        if (feeds[retailer]) feeds[retailer].timeoutSec = Math.max(10, Math.min(feeds[retailer].timeoutSec, Math.floor(remainingMs / 1000) - 10));
        const r = await monitor.runFeeds({ only: [retailer], force: cfg.force });
        fed.checks.push(...r.checks);
        fed.alerts.push(...r.alerts);
        fed.feeds.push(...r.feeds);
      }
      meta.lastTick.feeds = t0;
    }
    await monitor.flush();
  } catch (e) {
    error = e;
    note('error', `check phase failed: ${e.message}`);
    jlog.error('check.crash', { error: e.message });
  }
  for (const f of fed.feeds) if (f.status === 'error') note('warning', `feed ${f.retailer}: ${f.reason}`);
  // What the monitor did besides plain checks: items seen for the first time, trial shops (never checked from a datacenter IP).
  const lr = monitor.lastRun();
  if (lr.learned.length) note('notice', `learned ${lr.learned.length} new item(s) silently (first sight, no post): ${lr.learned.slice(0, 8).join(', ')}${lr.learned.length > 8 ? ', ...' : ''}`);
  if (lr.trialProven.length) note('notice', `trial shop answered a GitHub runner, now an ordinary shop: ${lr.trialProven.join(', ')}`);
  if (lr.trialBlocked.length) note('notice', `trial shop did not answer, resting: ${lr.trialBlocked.join(', ')}. See monitor/RECON.md and the shop's feed.`);
  if (lr.learned.length || lr.trialProven.length || lr.trialBlocked.length || lr.deadSkipped) jlog.info('check.coverage', { learned: lr.learned.length, trialProven: lr.trialProven, trialBlocked: lr.trialBlocked, restingTrial: lr.restingTrial, deadSkipped: lr.deadSkipped });
  for (const [id, h] of Object.entries(monitor.health().retailers)) if (h.status === 'blocked') note('warning', `${id} is blocked (${h.lastError}). It stays on, paused with backoff; see monitor/RECON.md.`);
  jlog.info('check.summary', { checks: scrape.checks.length + fed.checks.length, failed: [...scrape.checks, ...fed.checks].filter((c) => !c.ok).length, scrape: scrape.checks.length, feed: fed.checks.length, feeds: fed.feeds.map((f) => ({ retailer: f.retailer, status: f.status, reason: f.reason ?? null })) });

  // ---------- breaker: shops ----------
  for (const ev of updateRetailers(breakers, collectRetailerResults({ scrapeChecks: scrape.checks, feeds: fed.feeds }), now(), ops)) onEvent('retailer', ev);

  // ---------- breaker: price sanity (always, also in silent runs: it protects the 30-day history) ----------
  const itemsByKey = new Map(monitor.items.map((i) => [`${i.retailer}:${i.productKey}`, i]));
  const priceHold = new Map();
  for (const c of [...scrape.checks, ...fed.checks]) {
    if (!c.ok || c.inStock !== true) continue;
    const id = `${c.retailer}:${c.productKey}`;
    const hk = historyKey(c.retailer, c.productKey);
    const v = priceVerdict(c, itemsByKey.get(id), entries[hk]?.v ?? null, ops);
    if (v) {
      // keep the reading out of the price history and the stock state, as if this check never happened
      for (const k of [hk, stateKey(c.retailer, c.productKey)]) {
        if (entries[k]) await store.put(k, entries[k].v);
        else await store.delete(k);
      }
      priceHold.set(id, v);
      const q = breakers.quarantine[id];
      breakers.quarantine[id] = { since: q?.since ?? new Date(t0).toISOString(), lastAt: new Date(t0).toISOString(), price: v.price, reference: v.reference, source: v.source, reason: v.reason };
      if (!q) onEvent('price', { type: 'trip', product: id, ...v });
    } else if (breakers.quarantine[id]) {
      delete breakers.quarantine[id];
      onEvent('price', { type: 'lifted', product: id, price: c.price });
    }
  }

  // ---------- market log: our own readings for the weekly market report (every run, also silent ones) ----------
  // Readings the price breaker holds stay out, exactly as they stay out of the price history.
  try {
    const readings = [...scrape.checks, ...fed.checks].filter((c) => !priceHold.has(`${c.retailer}:${c.productKey}`));
    await store.put(MARKET_LOG_KEY, recordChecks(await store.get(MARKET_LOG_KEY), readings, { items: itemsByKey, cfg: ops.marketReport, now: t0 }));
  } catch (e) {
    note('warning', `market log not updated: ${e.message}`);
  }

  // ---------- guard the posts ----------
  const alerts = [...scrape.alerts, ...fed.alerts];
  const guarding = posting && !silent && !error;
  let postable = [];
  let heldNow = [];
  let released = [];
  let dupes = [];
  if (guarding) {
    const reason = new Map();
    for (const a of alerts) {
      const id = `${a.retailer}:${a.productKey}`;
      if (priceHold.has(id)) reason.set(a.key, `price:${priceHold.get(id).reason}`);
      else if (a.price === null || a.price === undefined) reason.set(a.key, 'price:price_missing');
    }
    const surge = surgeCheck(alerts.filter((a) => !reason.has(a.key)), breakers, now(), ops);
    for (const [k, r] of surge.hold) if (!reason.has(k)) reason.set(k, r);
    if (surge.event) onEvent('surge', surge.event);
    if (cfg.pause) for (const a of alerts) if (!reason.has(a.key)) reason.set(a.key, 'paused');
    heldNow = alerts.filter((a) => reason.has(a.key));
    postable = alerts.filter((a) => !reason.has(a.key));
    if (heldNow.length) {
      held = holdAlerts(held, heldNow.map((a) => ({ alert: a, reason: reason.get(a.key) })), now(), ops);
      jlog.warn('breaker.hold', { held: heldNow.map((a) => ({ key: a.key, reason: reason.get(a.key) })) });
      if (cfg.pause) note('warning', `LAGERFUNK_PAUSE is set: ${heldNow.length} post(s) held, nothing is posted`);
    }
    if (cfg.releaseHeld) {
      released = releasable(held, now(), STALE_AFTER_MS);
      note('notice', `release_held: ${released.length} held post(s) released, ${held.length - released.length} too old and dropped`);
      jlog.info('held.release', { released: released.map((a) => a.key), dropped: held.length - released.length });
      held = [];
      postable.push(...released);
    }
    const dd = dedupe(postable, ledger, now(), ops);
    dupes = dd.dupes;
    postable = dd.fresh;
    if (dupes.length) {
      jlog.info('dedupe.skip', { skipped: dupes.map((d) => ({ idem: d.idem, key: d.alert.key, prevAt: new Date(d.prevAt).toISOString() })) });
      note('notice', `${dupes.length} alert(s) skipped: already posted (${dupes.map((d) => d.idem).join(', ').slice(0, 200)})`);
    }
  }

  // ---------- post ----------
  let bot = null;
  let skipSave = false;
  let weekly = null; // the weekly market report of this run, when one is due
  let reportInfo = null;
  const stateFile = (ents) => {
    const text = serializeState(ents, { savedAt: new Date(now()).toISOString(), runId: env.GITHUB_RUN_ID ?? null });
    const clean = scrub(text, secrets);
    return clean.count ? clean.text : text;
  };
  const prevOk = loaded.files?.['state.json'] && parseState(loaded.files['state.json']).ok ? loaded.files['state.json'] : null;
  if (guarding) {
    try {
      const linkCheck = { enabled: ops.affiliate.checkLinks, ...linkExpectations(root, env) };
      const engineWith = (more = {}) => createEngine({ store, monitorStore: store, config: loadConfig(botEnv({ ...env, ...channel.envPatch }, brand), { linkCheck, ...more }), fetch: opts.fetch, ...(opts.clock ? { clock: opts.clock } : {}), log });
      // The weekly market report. Not while paused: it then goes out with the first run after the pause, if its slot is still open.
      if (!cfg.pause) {
        weekly = await prepareMarketReport({ store, now: now(), ops, root, items: [...monitor.items, ...monitor.disabledItems], botCfg: loadConfig(botEnv({ ...env, ...channel.envPatch }, brand), { linkCheck }), brand, note, jlog, admin });
        // Marked before anything is sent and saved with the checkpoint: a retry or the next run of the chain sees the week as handled.
        if (weekly) await store.put(MARKET_REPORT_KEY, markWeek(await store.get(MARKET_REPORT_KEY), weekly.week, { s: 'pending', at: new Date(now()).toISOString(), ch: channel.channel }, { keepReports: ops.marketReport.keepReports }));
      }
      let plan2 = telegramPlan(breakers, now());
      if (plan2 === 'probe') {
        try {
          await engineWith().telegram.getMe();
          onEvent('telegram', telegramAfterProbe(breakers, { ok: true }, now(), ops));
          plan2 = 'send';
        } catch (e) {
          onEvent('telegram', telegramAfterProbe(breakers, { ok: false, status: e.status ?? 0, error: e.message }, now(), ops));
          plan2 = 'hold';
        }
        jlog.info('breaker.probe', { breaker: 'telegram', result: plan2 });
      }
      // A pause stops every public send, also posts queued in the bot by earlier runs.
      const holding = plan2 === 'hold' || cfg.pause;
      if (plan2 === 'hold') note('notice', `Telegram breaker ${breakers.telegram.state} (${breakers.telegram.kind}): ${postable.length} post(s) queued, not sent before ${new Date(breakers.telegram.openUntil).toISOString()}`);

      // Checkpoint: save the state with these posts marked BEFORE sending anything. New alerts go into the ledger as
      // pending (the next run treats them as posted). Posts already queued in the bot that may go out now are saved
      // as in flight, which the bot never resends after a lost run (its strict "never twice" rule).
      const botKey = `${env.STORE_PREFIX || 'bot:'}state`;
      const soon = now() + 60000;
      const queued = holding ? [] : ((await store.get(botKey))?.outbox ?? []).filter((j) => !j.inf && Math.max(j.due ?? 0, j.nx ?? 0) <= soon);
      if ((postable.length || queued.length || weekly) && saving) {
        for (const a of postable) ledgerRecord(ledger, a, now(), holding ? 'queued' : 'pending', channel.channel);
        await store.put(LEDGER_KEY, ledger);
        await store.put(BREAKERS_KEY, breakers);
        await store.put(HELD_KEY, held);
        await store.put('runner:meta', meta);
        const ents = { ...store.entries() };
        if (queued.length && ents[botKey]) {
          const v = structuredClone(ents[botKey].v);
          const ids = new Set(queued.map((j) => j.id));
          for (const j of v.outbox) if (ids.has(j.id)) j.inf = now();
          v.lease = null;
          ents[botKey] = { ...ents[botKey], v };
        }
        try {
          const r = await backend.save({ 'state.json': stateFile(ents), 'state.prev.json': prevOk, 'activity.jsonl': loaded.files?.['activity.jsonl'] ?? null, 'status.json': loaded.files?.['status.json'] ?? null }, { token, message: `checkpoint ${new Date(now()).toISOString()} (${cfg.mode}, ${postable.length + queued.length + (weekly ? 1 : 0)} to post)` });
          token = r?.sha ?? token;
          jlog.info('state.checkpoint', { posts: postable.length, report: weekly?.week ?? null });
        } catch (e) {
          skipSave = true; // the final save would make the alerts look announced without a post: let the next run detect them again
          throw Object.assign(new Error(`checkpoint save failed, nothing was posted: ${e.message}`), { checkpoint: true });
        }
      }

      const engine = engineWith(holding ? { maxPostsPerRun: 0 } : {});
      const shopUrl = (a) => itemsByKey.get(`${a.retailer}:${a.productKey}`)?.url ?? null;
      bot = await engine.run({ alerts: postable.map((a) => ({ ...a, shopUrl: shopUrl(a) })), posts: weekly ? [{ id: weekly.id, post: weekly.post, expiresAt: weekly.until }] : [] });
      if (weekly) {
        const mine = (x) => String(x.key).endsWith(`:${weekly.id}`);
        const sent = bot.sent.find((s) => mine(s) && s.target === 'free') ?? bot.sent.find(mine);
        const dropped = bot.failed.find((f) => mine(f) && !f.retry);
        const status = sent ? 'sent' : dropped ? 'failed' : bot.posts ? 'queued' : 'skipped';
        reportInfo = { week: weekly.week, status, chars: weekly.post.length, affiliate: weekly.post.affiliate };
        await store.put(MARKET_REPORT_KEY, markWeek(await store.get(MARKET_REPORT_KEY), weekly.week, { s: status, at: new Date(now()).toISOString(), ch: channel.channel, m: sent?.messageId ?? null }, { model: weekly.model, keepReports: ops.marketReport.keepReports }));
        try {
          const f = writeReportFiles({ outDir: cfg.outDir, model: weekly.model, rc: weekly.rc, linkFor: weekly.linkFor });
          reportInfo.files = [path.basename(f.html), path.basename(f.json)];
        } catch (e) {
          note('warning', `market report files not written: ${e.message}`);
        }
        // in the post ledger too, so `ops.mjs retract --key marktbericht` and `ops.mjs status` find it like any post
        if (sent) ledger[`marktbericht|${weekly.week}`] = { at: now(), k: sent.key, s: 'sent', ch: channel.channel, m: sent.messageId ?? null, sentAt: sent.at ?? null };
        jlog[status === 'failed' ? 'warn' : 'info'](`report.${status}`, { week: weekly.week, channel: channel.channel, messageId: sent?.messageId ?? null });
        note(status === 'failed' ? 'warning' : 'notice', `weekly market report ${weekly.week}: ${status}${status === 'skipped' ? ' (the bot had already taken this id)' : ''}`);
        if (status === 'failed') admin.raise(`report-send:${weekly.week}`, `[WARN] The weekly market report ${weekly.week} was not delivered: ${dropped.error}. It is not sent again by itself (one report per week). RUNBOOK: weekly market report.`);
      }
      ledgerMarkSent(ledger, bot.sent, channel.channel);
      for (const s of bot.sent) jlog.info('post.sent', { key: s.key, target: s.target, channel: channel.channel });
      for (const f of bot.failed) jlog.warn('post.failed', { key: f.key, status: f.status ?? null, error: f.error, retry: f.retry });
      if (plan2 !== 'hold' && !cfg.pause) for (const ev of telegramUpdate(breakers, bot, now(), ops)) onEvent('telegram', ev);
      for (const l of bot.links ?? []) {
        jlog.warn('link.fallback', l);
        admin.raise(`link:${l.retailer}:${l.reason}`, `[WARN] Affiliate link for ${l.retailer} failed the check (${l.reason}). ${l.action === 'plain' ? 'Posted with the plain shop link, no affiliate tracking on it.' : 'Post dropped: no clean link.'} Check AWIN_AFFILIATE_ID, AWIN_MIDS and the feed link. RUNBOOK: affiliate network down.`);
      }
      if (bot.links?.length) note('warning', `${bot.links.length} affiliate link(s) failed the check and were posted plain or dropped`);
      if (env.ADMIN_IDS && cfg.mode !== 'feeds' && !holding) {
        try {
          await engine.pollCommands({ timeoutSec: 0 });
        } catch (e) {
          note('notice', `commands not polled: ${e.message}`);
        }
      }
      if (bot.failed.length) note('warning', `${bot.failed.length} post(s) failed: ${bot.failed.map((f) => f.error).join('; ').slice(0, 200)}`);
    } catch (e) {
      error = e;
      note('error', `${e.checkpoint ? '' : 'bot phase failed: '}${e.message}`);
      if (e.checkpoint) admin.raise('checkpoint', `[ALERT] The state could not be saved before posting, so nothing was posted in this run. The alerts will be detected again next run. Error: ${e.message.slice(0, 300)}`, { severity: 'critical' });
      if (weekly && !reportInfo) {
        // checkpoint failed: nothing was saved, the next run builds the report again. Bot crash after the checkpoint: the
        // week stays marked "pending" and is not posted twice.
        reportInfo = { week: weekly.week, status: e.checkpoint ? 'retry' : 'pending' };
        if (!e.checkpoint) admin.raise(`report-crash:${weekly.week}`, `[WARN] The weekly market report ${weekly.week} may not have gone out (bot phase failed: ${e.message.slice(0, 200)}). It is not sent again by itself. Check the channel; RUNBOOK: weekly market report.`);
      }
    }
  } else if (alerts.length) {
    note('notice', `${alerts.length} alert(s) detected and not posted (${cfg.dryRun ? 'dry run' : silent ? 'silent run' : 'check phase failed'})`);
  }
  if (authTrip && !error) {
    error = new Error('Telegram refused the bot (401/403): posting is paused by the circuit breaker');
  }

  // ---------- the watchdog is watched too (hourly, git backend only) ----------
  if (saving && backend.kind === 'git' && t0 - (meta.lastWatchdogCheck ?? 0) >= 3600000) {
    meta.lastWatchdogCheck = t0;
    try {
      const opsBranch = await readBranch({ git, branch: OPS_BRANCH });
      const wd = opsBranch.status === 'ok' ? JSON.parse((await opsBranch.read('watchdog.json')) ?? 'null') : null;
      const last = wd?.lastRunAt ? Date.parse(wd.lastRunAt) : null;
      const age = last ? Math.round((t0 - last) / 60000) : null;
      const runningSince = Date.parse(meta.firstRunAt ?? new Date(t0).toISOString());
      if ((age !== null && age > ops.deadman.watchdogStaleMinutes) || (age === null && t0 - runningSince > 24 * 3600000)) {
        admin.raise('watchdog-stale', `[ALERT] The watchdog has not run for ${age === null ? 'ever' : `${age} min`}. Nobody is watching the runner. Check Actions, lagerfunk-watchdog: is it disabled? RUNBOOK: Actions disabled.`, { severity: 'critical' });
        jlog.warn('watchdog.stale', { minutes: age });
      }
    } catch (e) {
      jlog.warn('watchdog.check_failed', { error: e.message });
    }
  }

  // ---------- admin alerts (not in dry runs: nothing is saved there, so the dedupe could not hold) ----------
  let adminRes = { configured: admin.configured, sent: 0, failed: 0, pending: adminState.outbox.length, error: null };
  if (saving) adminRes = await admin.flush();
  if (adminRes.sent) jlog.info('admin.sent', { sent: adminRes.sent, keys: adminRes.keys });
  if (adminRes.error) note('warning', `admin alert not delivered: ${adminRes.error}`);
  if (!adminRes.configured && adminRes.pending) note('warning', `TELEGRAM_ADMIN_CHAT_ID is not set: ${adminRes.pending} admin alert(s) wait in the state (runner:admin) and in this log only`);

  // ---------- activity and state ----------
  const tEnd = now();
  meta.runs += 1;
  meta.lastRunAt = new Date(tEnd).toISOString();
  await store.put('runner:meta', meta);
  await store.put(BREAKERS_KEY, breakers);
  await store.put(LEDGER_KEY, ledger);
  await store.put(HELD_KEY, held);
  await store.put(ADMIN_KEY, adminState);
  const st = monitor.status();
  let stateText = serializeState(store.entries(), { savedAt: new Date(tEnd).toISOString(), runId: env.GITHUB_RUN_ID ?? null });
  const cleanState = scrub(stateText, secrets);
  if (cleanState.count) {
    stateText = cleanState.text;
    note('error', `${cleanState.count} secret value(s) found in the state and removed before saving. Find out where they came from.`);
    if (!parseState(stateText).ok) throw new Error('state is not valid after scrubbing: refusing to save');
  }
  const willSave = saving && !skipSave;
  const latched = Object.keys(breakers.surge.latched).filter((r) => breakers.surge.latched[r] > tEnd);
  const activity = buildActivity({
    at: tEnd,
    mode: cfg.mode,
    profile: profile.name,
    durationMs: tEnd - t0,
    scrapeChecks: scrape.checks,
    feedChecks: fed.checks,
    alerts,
    bot,
    feeds: fed.feeds,
    shops: { active: st.active, disabled: st.disabled },
    state: { keys: Object.keys(store.entries()).length, bytes: Buffer.byteLength(stateText), pushed: willSave, reset },
    run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, event: env.GITHUB_EVENT_NAME, sha: env.GITHUB_SHA?.slice(0, 7), idleDays, code: env.CODE_SHA ?? null },
    notes,
    ok: !error,
    extra: {
      channel: channel.channel,
      breakers: { open: openRetailers(breakers), telegram: breakers.telegram.state, surge: latched.length > 0, quarantined: Object.keys(breakers.quarantine).length, events },
      posts: { held: heldNow.length, released: released.length, duplicates: dupes.length, linkFallbacks: bot?.links?.length ?? 0 },
      admin: { sent: adminRes.sent, pending: adminRes.pending, failed: adminRes.failed },
      ...(reportInfo ? { report: { week: reportInfo.week, status: reportInfo.status } } : {}),
    },
  });
  const activityText = scrub(appendActivity(loaded.files?.['activity.jsonl'], activity), secrets).text;
  const statusExtras = {
    channel: channel.channel,
    version: env.CODE_SHA ?? env.GITHUB_SHA?.slice(0, 7) ?? null,
    breakers: { retailersOpen: openRetailers(breakers), telegram: breakers.telegram.state, telegramKind: breakers.telegram.kind, surgeLatched: latched, quarantined: Object.keys(breakers.quarantine).length },
    held: held.length,
    alertAfterMinutes: ops.deadman.alertAfterMinutes,
  };
  const statusText = `${JSON.stringify(buildStatus(parseActivity(activityText), tEnd, statusExtras), null, 1)}\n`;
  const files = { 'state.json': stateText, 'state.prev.json': prevOk, 'activity.jsonl': activityText, 'status.json': statusText };

  mkdirSync(cfg.outDir, { recursive: true });
  writeFileSync(path.join(cfg.outDir, 'activity-last.json'), `${JSON.stringify(activity, null, 1)}\n`);
  if (!willSave) {
    writeFileSync(path.join(cfg.outDir, 'state.json'), stateText);
    if (skipSave) note('error', 'the state was NOT saved on purpose (the checkpoint failed), so the next run detects the same alerts again and can post them. The state is in deploy/out/state.json.');
  } else {
    try {
      const r = await backend.save(files, { token, message: `state ${new Date(tEnd).toISOString()} (${cfg.mode})` });
      jlog.info('state.saved', { bytes: Buffer.byteLength(stateText), attempts: r?.attempts ?? 1 });
    } catch (e) {
      writeFileSync(path.join(cfg.outDir, 'state.json'), stateText); // the workflow uploads deploy/out when a run fails
      const posted = bot?.sent?.length ?? 0;
      note('error', `state could not be saved: ${e.message}.${posted ? ` ${posted} post(s) went out in this run; the checkpoint saved before posting marks them as announced, so the next run does not repeat them.` : ''} The state is in deploy/out/state.json.`);
      jlog.error('state.save_failed', { error: e.message, posted });
      error = e;
    }
  }

  summary(env, cfg, activity, st, out);
  jlog[error ? 'error' : 'info']('run.end', {
    ok: !error, durationMs: activity.durationMs, checks: activity.checks, alerts: activity.alerts, posts: activity.posts, breakers: activity.breakers, admin: activity.admin, channel: channel.channel,
  });
  return { ok: !error, activity, alerts, bot, files, error: error ?? undefined, held, breakers, ledger, report: reportInfo, jsonLog: jlog.lines };
}

function summary(env, cfg, a, st, out) {
  out(`${a.at} ${cfg.mode}: ${a.checks.total} checks (${a.checks.failed} failed), ${a.alerts.detected} alerts (${a.alerts.sent} posted), ${a.feeds.length} feeds, ${a.durationMs} ms, state ${Math.round(a.state.bytes / 1024)} KB`);
  for (const e of a.errors) out(`  ${e.retailer}: ${e.error} x${e.n}`);
  for (const f of a.feeds) out(`  feed ${f.retailer}: ${f.status}${f.reason ? ` (${f.reason})` : ''}, ${f.rows} rows, ${f.matched}/${f.items} matched`);
  if (a.posts && (a.posts.held || a.posts.duplicates || a.posts.released)) out(`  posts: ${a.posts.held} held, ${a.posts.released} released, ${a.posts.duplicates} duplicates skipped`);
  if (a.breakers?.open?.length) out(`  breakers open: ${a.breakers.open.join(', ')}`);
  if (env.GITHUB_STEP_SUMMARY) {
    const rows = st.retailers.map((r) => `| ${r.retailer} | ${r.source ? `on (${r.source})` : 'off'} | ${r.items} |`).join('\n');
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${cfg.mode} (${a.channel ?? 'public'}): ${a.checks.total} checks, ${a.checks.failed} failed, ${a.alerts.detected} alerts, ${a.alerts.sent} posted, ${a.posts?.held ?? 0} held\n\n| shop | state | items |\n|---|---|---|\n${rows}\n`);
  }
}
