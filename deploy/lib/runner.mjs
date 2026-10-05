// One run of the Lagerfunk monitor + bot, built for a scheduled GitHub Actions job (also runs on a laptop).
//
//   node deploy/run.mjs --mode watch     shops that can be fetched without a proxy (every 10 minutes)
//   node deploy/run.mjs --mode feeds     affiliate product feeds: Proshop, Cyberport, computeruniverse, Galaxus (hourly)
//   node deploy/run.mjs --mode all       both (manual runs)
//   node deploy/run.mjs --mode status    print what the profile switches on and off, no network, no state
//
// Order of work: read state, check, post alerts through the bot, write state back. The state is written exactly once,
// at the end, as one commit on the "state" branch together with the activity line for the dashboard.
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMonitor } from '../../monitor/src/monitor.js';
import { resolveProfile } from '../../monitor/src/profile.js';
import { feedsFromEnv } from '../../monitor/src/feeds/index.js';
import { createEngine } from '../../bot/src/engine.js';
import { loadConfig } from '../../bot/src/config.js';
import { createStateStore, serializeState, parseState } from './store.mjs';
import { collectSecrets, scrub } from './secrets.mjs';
import { buildActivity, appendActivity, parseActivity, buildStatus } from './activity.mjs';
import { createGit, fetchState, pushState } from './gitstate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');
export const MODES = ['watch', 'feeds', 'all', 'status'];
const TICK_MS = 10 * 60000;
const MAX_SINCE_MS = 2 * 3600000;
export const IDLE_WARN_DAYS = 45; // GitHub switches scheduled workflows off in a public repo after 60 days without activity

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

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

function clampSince(last, t0) {
  if (!Number.isFinite(last) || last <= 0) return t0 - TICK_MS;
  return Math.max(last, t0 - MAX_SINCE_MS);
}

function readBrand(root) {
  for (const f of ['brand.json', 'site/brand.json']) if (existsSync(path.join(root, f))) return JSON.parse(readFileSync(path.join(root, f), 'utf8'));
  return null;
}

/**
 * @param {object} opts  everything injectable for tests: env, argv, fetch, now, sleep, backend, git, root, out, jitterMs
 * @returns {Promise<{ ok: boolean, activity: object|null, alerts: object[], bot: object|null, files: object, error?: Error }>}
 */
export async function runOnce(opts = {}) {
  const env = opts.env ?? process.env;
  const root = opts.root ?? ROOT;
  const cfg = parseArgs(opts.argv ?? [], env, root);
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const out = opts.out ?? ((line) => console.log(line));
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

  // Posting without a bot token would consume the state transitions and lose the alerts. Fail before touching anything.
  const posting = !cfg.dryRun && !cfg.silent;
  if (posting && !env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set. Add it as a repository secret, or run with SILENT=1 or DRY_RUN=1.');

  // ---------- state ----------
  const git = opts.git ?? createGit({ cwd: root, env });
  const backend = opts.backend ?? (cfg.stateDir ? dirBackend(path.resolve(root, cfg.stateDir)) : gitBackend({ git, sleep }));
  const loaded = await backend.load();
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
  const silent = cfg.silent || reset || restoredFromPrev;
  const idleDays = env.GITHUB_ACTIONS === 'true' || opts.git ? await repoIdleDays(git, t0) : null;
  if (idleDays !== null && idleDays >= IDLE_WARN_DAYS) note('warning', `the repository has had no commit for ${idleDays} days. GitHub switches scheduled jobs off after 60 days without activity. Commit any small change (for example a blank line in README.md) to reset the clock.`);

  const store = createStateStore({ entries, now });
  const meta = (await store.get('runner:meta')) ?? { runs: 0, firstRunAt: new Date(t0).toISOString(), lastTick: {} };
  meta.lastTick ??= {};

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
      const r = await monitor.tick({ tickMs: TICK_MS, since: clampSince(meta.lastTick.watch, t0), source: 'scrape' });
      scrape.checks.push(...r.checks);
      scrape.alerts.push(...r.alerts);
      meta.lastTick.watch = t0;
    }
    if (cfg.mode === 'feeds' || cfg.mode === 'all') {
      const retailers = [...new Set(monitor.items.filter((i) => i._source === 'feed').map((i) => i.retailer))];
      for (const retailer of retailers) {
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
  }
  for (const f of fed.feeds) if (f.status === 'error') note('warning', `feed ${f.retailer}: ${f.reason}`);
  for (const [id, h] of Object.entries(monitor.health().retailers)) if (h.status === 'blocked') note('warning', `${id} is blocked (${h.lastError}). It stays on, paused with backoff; see monitor/RECON.md.`);

  // ---------- post ----------
  const alerts = [...scrape.alerts, ...fed.alerts];
  let bot = null;
  if (posting && !silent && !error) {
    try {
      const engine = createEngine({ store, monitorStore: store, config: loadConfig(botEnv(env, brand)), fetch: opts.fetch, ...(opts.clock ? { clock: opts.clock } : {}), log });
      bot = await engine.run({ alerts });
      if (env.ADMIN_IDS && cfg.mode !== 'feeds') {
        try {
          await engine.pollCommands({ timeoutSec: 0 });
        } catch (e) {
          note('notice', `commands not polled: ${e.message}`);
        }
      }
      if (bot.failed.length) note('warning', `${bot.failed.length} post(s) failed: ${bot.failed.map((f) => f.error).join('; ').slice(0, 200)}`);
    } catch (e) {
      error = e;
      note('error', `bot phase failed: ${e.message}`);
    }
  } else if (alerts.length) {
    note('notice', `${alerts.length} alert(s) detected and not posted (${cfg.dryRun ? 'dry run' : silent ? 'silent run' : 'check phase failed'})`);
  }

  // ---------- activity and state ----------
  const tEnd = now();
  meta.runs += 1;
  meta.lastRunAt = new Date(tEnd).toISOString();
  await store.put('runner:meta', meta);
  const st = monitor.status();
  let stateText = serializeState(store.entries(), { savedAt: new Date(tEnd).toISOString(), runId: env.GITHUB_RUN_ID ?? null });
  const cleanState = scrub(stateText, secrets);
  if (cleanState.count) {
    stateText = cleanState.text;
    note('error', `${cleanState.count} secret value(s) found in the state and removed before saving. Find out where they came from.`);
    if (!parseState(stateText).ok) throw new Error('state is not valid after scrubbing: refusing to save');
  }
  const saving = !cfg.dryRun && !cfg.noPush;
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
    state: { keys: Object.keys(store.entries()).length, bytes: Buffer.byteLength(stateText), pushed: saving, reset },
    run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, event: env.GITHUB_EVENT_NAME, sha: env.GITHUB_SHA?.slice(0, 7), idleDays },
    notes,
    ok: !error,
  });
  const activityText = scrub(appendActivity(loaded.files?.['activity.jsonl'], activity), secrets).text;
  const statusText = `${JSON.stringify(buildStatus(parseActivity(activityText), tEnd), null, 1)}\n`;
  const prevOk = loaded.files?.['state.json'] && parseState(loaded.files['state.json']).ok ? loaded.files['state.json'] : null;
  const files = { 'state.json': stateText, 'state.prev.json': prevOk, 'activity.jsonl': activityText, 'status.json': statusText };

  mkdirSync(cfg.outDir, { recursive: true });
  writeFileSync(path.join(cfg.outDir, 'activity-last.json'), `${JSON.stringify(activity, null, 1)}\n`);
  if (!saving) {
    writeFileSync(path.join(cfg.outDir, 'state.json'), stateText);
  } else {
    try {
      await backend.save(files, { token: loaded.token, message: `state ${new Date(tEnd).toISOString()} (${cfg.mode})` });
    } catch (e) {
      writeFileSync(path.join(cfg.outDir, 'state.json'), stateText); // the workflow uploads deploy/out when a run fails
      const posted = bot?.sent?.length ?? 0;
      note('error', `state could not be saved: ${e.message}.${posted ? ` ${posted} post(s) went out in this run and may be repeated by the next one.` : ''} The state is in deploy/out/state.json.`);
      error = e;
    }
  }

  summary(env, cfg, activity, st, out);
  return { ok: !error, activity, alerts, bot, files, error: error ?? undefined };
}

function summary(env, cfg, a, st, out) {
  out(`${a.at} ${cfg.mode}: ${a.checks.total} checks (${a.checks.failed} failed), ${a.alerts.detected} alerts (${a.alerts.sent} posted), ${a.feeds.length} feeds, ${a.durationMs} ms, state ${Math.round(a.state.bytes / 1024)} KB`);
  for (const e of a.errors) out(`  ${e.retailer}: ${e.error} x${e.n}`);
  for (const f of a.feeds) out(`  feed ${f.retailer}: ${f.status}${f.reason ? ` (${f.reason})` : ''}, ${f.rows} rows, ${f.matched}/${f.items} matched`);
  if (env.GITHUB_STEP_SUMMARY) {
    const rows = st.retailers.map((r) => `| ${r.retailer} | ${r.source ? `on (${r.source})` : 'off'} | ${r.items} |`).join('\n');
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${cfg.mode}: ${a.checks.total} checks, ${a.checks.failed} failed, ${a.alerts.detected} alerts, ${a.alerts.sent} posted\n\n| shop | state | items |\n|---|---|---|\n${rows}\n`);
  }
}
