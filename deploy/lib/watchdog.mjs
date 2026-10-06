// The watchdog: a separate scheduled workflow (hourly, and right after any runner run that did not succeed) that
// reads what the runner wrote and alerts the owner's admin chat. It cannot be skipped by the runner failing, because it
// is not part of the runner's job.
//
//   dead man    no good run for deadman.alertAfterMinutes (40): alert, then a reminder every remindEveryMinutes,
//               and a recovery notice once a good run shows up again.
//   blind       runs are fine but no single check has succeeded for blindAfterMinutes: every shop blocks us.
//   schedule    GitHub reports a workflow as disabled (60 days without activity, or switched off by hand): alert and
//               switch it back on through the API.
//   keepalive   main has had no commit for keepalive.actAfterDays: re-enable the workflows through the API and add an
//               empty commit on main, once a day, so GitHub's 60-day inactivity rule never switches the schedules off.
//   Telegram    the runner reports the Telegram breaker open for "auth" (token revoked): alert. That alert cannot reach
//               Telegram with the same token, so the watchdog run fails instead: GitHub e-mails the owner (at most
//               every remindEveryMinutes).
//   backup      once a day: today's copy of the state branch to ops:backups/, newest 7 kept, read back to prove it.
//   digest      once a day after digest.hourBerlin: runs, posts, shops, errors, clicks (Awin, when configured).
//
// The watchdog's own memory is ops:watchdog.json. The runner checks that file hourly, so a dead watchdog is noticed too.
import { fetchState } from './gitstate.mjs';
import { readBranch, writeBranch, OPS_BRANCH } from './opsbranch.mjs';
import { parseActivity } from './activity.mjs';
import { parseState } from './store.mjs';
import { planBackup, backupDates, BACKUP_DIR } from './backup.mjs';
import { createAdmin, loadAdminState, emptyAdminState } from './admin.mjs';
import { createJsonLog, personalValues } from './log.mjs';
import { collectSecrets, scrub } from './secrets.mjs';
import { loadOpsConfig } from './config.mjs';
import { idleDaysFrom } from './runner.mjs';
import { berlinDate } from '../../monitor/src/util.js';

export const WATCHDOG_FILE = 'watchdog.json';
export const WATCHED_WORKFLOWS = ['lagerfunk.yml', 'watchdog.yml'];
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();
const hhmm = (msOrIso) => new Date(typeof msOrIso === 'number' ? msOrIso : Date.parse(msOrIso)).toISOString().slice(11, 16);
const berlinHour = (ms) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ms)));

export function emptyWatchdog() {
  return {
    v: 1, status: 'unknown', firstSeenAt: null, downSince: null, lastAlertAt: null, blind: false, blindSince: null, blindAlertAt: null,
    telegramAuthAlertAt: null, lastRunAt: null, digestSentFor: null, backups: { lastDate: null, dates: [] }, keepalive: { lastAt: null, method: null },
    schedule: {}, redAt: null, admin: emptyAdminState(),
  };
}

export function loadWatchdog(v) {
  const e = emptyWatchdog();
  if (!v || typeof v !== 'object') return e;
  return { ...e, ...v, backups: { ...e.backups, ...(v.backups ?? {}) }, keepalive: { ...e.keepalive, ...(v.keepalive ?? {}) }, schedule: { ...(v.schedule ?? {}) }, admin: loadAdminState(v.admin) };
}

/** The heartbeat from status.json, also from a status.json written before the heartbeat field existed. */
export function heartbeatOf(status) {
  if (!status) return null;
  if (status.heartbeat) return status.heartbeat;
  return { lastRun: status.last ? { at: status.last.at, ok: status.last.ok } : null, lastGood: status.lastOkAt ? { at: status.lastOkAt, ok: true } : null, lastCheckOkAt: undefined };
}

/**
 * Pure decision step. Mutates and returns `wd`; returns the actions to carry out.
 * @param {object} o
 * @param {number} o.now
 * @param {object|null} o.status    status.json of the state branch
 * @param {object} o.wd             loadWatchdog(...)
 * @param {{file:string,state:string|null}[]|null} o.workflows  from the GitHub API, null when unknown
 * @param {number|null} o.idleDays  days since main's newest commit
 * @param {object} o.cfg            ops config
 * @param {string|null} [o.repo]    owner/name, for links in alert texts
 * @param {boolean} [o.forceDigest]
 */
export function evaluateWatchdog({ now, status, wd, workflows = null, idleDays = null, cfg, repo = null, forceDigest = false }) {
  const d = cfg.deadman;
  const actions = [];
  const alert = (key, text, severity = 'warn', extra = {}) => actions.push({ type: 'alert', key, text, severity, ...extra });
  const runsUrl = repo ? `https://github.com/${repo}/actions` : 'GitHub, Actions';
  wd.firstSeenAt ??= iso(now);
  wd.lastRunAt = iso(now);

  // dead man
  const hb = heartbeatOf(status);
  const lastGoodAt = hb?.lastGood?.at ?? null;
  const sinceGood = lastGoodAt ? (now - Date.parse(lastGoodAt)) / MIN : null;
  const down = lastGoodAt ? sinceGood > d.alertAfterMinutes : (now - Date.parse(wd.firstSeenAt)) / MIN > d.firstRunGraceMinutes;
  const lastRun = hb?.lastRun;
  const why = status?.last?.notes?.find((n) => /^error/.test(n)) ?? status?.last?.notes?.[0] ?? null;
  const detail = [
    lastGoodAt ? `Last good run ${hhmm(lastGoodAt)} UTC (${Math.round(sinceGood)} min ago${hb.lastGood.runId ? `, run ${hb.lastGood.runId}` : ''}${hb.lastGood.checked !== undefined ? `, ${hb.lastGood.checked} checks` : ''}).` : 'No good run recorded yet.',
    lastRun && lastRun.at !== lastGoodAt ? `Last run ${hhmm(lastRun.at)} UTC: ${lastRun.ok ? 'ok' : 'FAILED'}.` : null,
    why ? `Note: ${String(why).slice(0, 300)}` : null,
    `Runs: ${runsUrl}. RUNBOOK: runner stopped.`,
  ].filter(Boolean).join('\n');
  if (down) {
    if (wd.status !== 'down') {
      wd.status = 'down';
      wd.downSince = lastGoodAt ?? wd.firstSeenAt;
      wd.lastAlertAt = iso(now);
      alert(`deadman:${wd.downSince}`, `[ALERT] Runner down: no good run for ${lastGoodAt ? `${Math.round(sinceGood)} min` : 'the whole time the watchdog has watched'}.\n${detail}`, 'critical');
    } else if (now - Date.parse(wd.lastAlertAt) >= d.remindEveryMinutes * MIN) {
      wd.lastAlertAt = iso(now);
      alert(`deadman-remind:${wd.downSince}:${iso(now)}`, `[ALERT] Runner still down since ${hhmm(wd.downSince)} UTC (${Math.round((now - Date.parse(wd.downSince)) / MIN)} min).\n${detail}`, 'critical');
    }
  } else {
    if (wd.status === 'down') {
      alert(`deadman-recover:${wd.downSince}`, `[OK] Runner recovered: good run at ${hhmm(lastGoodAt)} UTC after ${Math.round((Date.parse(lastGoodAt) - Date.parse(wd.downSince)) / MIN)} min down.`, 'info');
      wd.downSince = null;
    }
    wd.status = lastGoodAt ? 'up' : 'unknown';
  }

  // blind: runs succeed, checks do not
  if (!down && lastGoodAt && hb?.lastCheckOkAt !== undefined) {
    const lastOk = hb.lastCheckOkAt ? Date.parse(hb.lastCheckOkAt) : null;
    const blind = lastOk === null ? (now - Date.parse(wd.firstSeenAt)) / MIN > d.blindAfterMinutes : (now - lastOk) / MIN > d.blindAfterMinutes;
    if (blind && !wd.blind) {
      wd.blind = true;
      wd.blindSince = hb.lastCheckOkAt ?? wd.firstSeenAt;
      wd.blindAlertAt = iso(now);
      alert(`blind:${wd.blindSince}`, `[ALERT] Runner is blind: runs finish, but no shop check has succeeded since ${hb.lastCheckOkAt ? `${hhmm(hb.lastCheckOkAt)} UTC` : 'the start'}. Every shop blocks us or every page changed. Open shops: ${(status?.breakers?.retailersOpen ?? []).join(', ') || 'none'}. RUNBOOK: retailer layout change or block.`, 'critical');
    } else if (blind && wd.blind && now - Date.parse(wd.blindAlertAt) >= d.remindEveryMinutes * MIN) {
      wd.blindAlertAt = iso(now);
      alert(`blind-remind:${wd.blindSince}:${iso(now)}`, `[ALERT] Runner still blind since ${hhmm(wd.blindSince)} UTC.`, 'critical');
    } else if (!blind && wd.blind) {
      wd.blind = false;
      alert(`blind-recover:${wd.blindSince}`, `[OK] Checks succeed again (last ${hhmm(hb.lastCheckOkAt)} UTC).`, 'info');
      wd.blindSince = null;
    }
  }

  // Telegram refuses the bot: the runner keeps running, posting is impossible
  const tg = status?.breakers;
  if (tg?.telegram && tg.telegram !== 'closed' && tg.telegramKind === 'auth') {
    if (!wd.telegramAuthAlertAt || now - Date.parse(wd.telegramAuthAlertAt) >= d.remindEveryMinutes * MIN) {
      wd.telegramAuthAlertAt = iso(now);
      alert(`telegram-auth:${iso(now)}`, '[ALERT] Telegram refuses the bot (token revoked or admin rights lost). Nothing can be posted. RUNBOOK: Telegram token revoked.', 'critical', { mustReach: true });
    }
  } else wd.telegramAuthAlertAt = null;

  // schedules
  for (const w of workflows ?? []) {
    const prev = wd.schedule[w.file];
    wd.schedule[w.file] = w.state;
    if (w.state && w.state !== 'active') {
      actions.push({ type: 'enable', workflow: w.file });
      alert(`schedule:${w.file}:${w.state}`, `[ALERT] GitHub reports workflow ${w.file} as "${w.state}": its schedule does not run. The watchdog tries to switch it back on now. RUNBOOK: Actions disabled.`, 'critical');
    } else if (prev && prev !== 'active' && w.state === 'active') {
      alert(`schedule-ok:${w.file}:${iso(now)}`, `[OK] Workflow ${w.file} is active again.`, 'info');
    }
  }

  // keepalive
  if (idleDays !== null && idleDays >= cfg.keepalive.actAfterDays && (!wd.keepalive.lastAt || now - Date.parse(wd.keepalive.lastAt) >= 86400000)) actions.push({ type: 'keepalive', idleDays });

  // backup and digest
  const today = berlinDate(now);
  if (wd.backups.lastDate !== today) actions.push({ type: 'backup', date: today });
  if (forceDigest || (berlinHour(now) >= cfg.digest.hourBerlin && wd.digestSentFor !== today)) actions.push({ type: 'digest', date: today });
  return { wd, actions };
}

// ---------- digest ----------

/** Plain-text daily digest for the admin chat. */
export function buildDigest({ now, lines = [], status = null, breakers = null, wd, idleDays = null, cfg, clicks = null, version = null }) {
  const day = lines.filter((l) => now - Date.parse(l.at) <= 86400000);
  const sum = (f) => day.reduce((n, l) => n + (f(l) ?? 0), 0);
  const good = day.filter((l) => l.ok).length;
  const shops = new Map();
  for (const l of day) {
    for (const [r, v] of Object.entries(l.byRetailer ?? {})) {
      const s = shops.get(r) ?? { ok: 0, failed: 0 };
      s.ok += Array.isArray(v) ? v[0] : v.ok ?? 0;
      s.failed += Array.isArray(v) ? v[1] : v.failed ?? 0;
      shops.set(r, s);
    }
  }
  const open = new Set(status?.breakers?.retailersOpen ?? Object.entries(breakers?.retailers ?? {}).filter(([, r]) => r.state !== 'closed').map(([id]) => id));
  const shopLine = [...shops.entries()].sort().map(([r, s]) => `${r} ${s.ok}/${s.ok + s.failed}${open.has(r) ? ' PAUSED' : ''}`).join(', ') || 'no checks';
  const errs = new Map();
  for (const l of day) for (const e of l.errors ?? []) errs.set(`${e.retailer} ${e.error}`, (errs.get(`${e.retailer} ${e.error}`) ?? 0) + e.n);
  const topErr = [...errs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} x${n}`).join('; ') || 'none';
  const clickLine = clicks?.ok ? `${clicks.total} (Awin, ${clicks.date}${clicks.byAdvertiser?.length ? `: ${clicks.byAdvertiser.map((a) => `${a.name} ${a.clicks}`).join(', ')}` : ''})` : `not available${clicks?.error ? ` (${clicks.error})` : ''}`;
  const tg = status?.breakers?.telegram ?? breakers?.telegram?.state ?? 'closed';
  return [
    `[DIGEST] ${berlinDate(now)} (${status?.channel ?? 'channel unknown'}${version || status?.version ? `, code ${version ?? status.version}` : ''})`,
    `Health: ${status?.health ?? 'unknown'}. Watchdog: ${wd.status}${wd.blind ? ', blind' : ''}.`,
    `Runs 24h: ${day.length} (good ${good}, failed ${day.length - good}). Last good: ${status?.heartbeat?.lastGood?.at ? `${hhmm(status.heartbeat.lastGood.at)} UTC` : status?.lastOkAt ? `${hhmm(status.lastOkAt)} UTC` : 'none'}.`,
    `Checks: ${sum((l) => l.checks?.total)} (failed ${sum((l) => l.checks?.failed)}).`,
    `Posts: detected ${sum((l) => l.alerts?.detected)}, posted ${sum((l) => l.alerts?.sent)}, held ${sum((l) => l.posts?.held)}, duplicates skipped ${sum((l) => l.posts?.duplicates)}, plain-link fallbacks ${sum((l) => l.posts?.linkFallbacks)}.`,
    `Shops (ok/checks): ${shopLine}.`,
    `Telegram: ${tg}. Admin alerts sent 24h: ${sum((l) => l.admin?.sent)}.`,
    `Clicks yesterday: ${clickLine}.`,
    `Top errors: ${topErr}.`,
    `Backups: ${wd.backups.dates?.length ?? 0} kept, newest ${wd.backups.lastDate ?? 'none'}.${idleDays !== null && idleDays >= cfg.keepalive.warnAfterDays ? ` Main has had no commit for ${idleDays} days (keepalive acts at ${cfg.keepalive.actAfterDays}).` : ''}`,
  ].join('\n');
}

// ---------- GitHub API ----------

async function ghApi({ env, fetch: fetchImpl }, method, path, body = null) {
  const base = env.GITHUB_API_URL || 'https://api.github.com';
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN) return { ok: false, status: 0, error: 'GITHUB_REPOSITORY or GITHUB_TOKEN not set' };
  try {
    const res = await fetchImpl(`${base}/repos/${env.GITHUB_REPOSITORY}${path}`, {
      method,
      headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, error: res.ok ? null : json?.message ?? `http ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

/** State of each watched workflow ("active", "disabled_inactivity", "disabled_manually", ...), or null when unknown. */
export async function workflowStates(ctx, files = WATCHED_WORKFLOWS) {
  const out = [];
  for (const file of files) {
    const r = await ghApi(ctx, 'GET', `/actions/workflows/${file}`);
    if (!r.ok) return null;
    out.push({ file, state: r.json?.state ?? null });
  }
  return out;
}

export async function enableWorkflow(ctx, file) {
  const r = await ghApi(ctx, 'PUT', `/actions/workflows/${file}/enable`);
  return { ok: r.ok || r.status === 204, status: r.status, error: r.error };
}

/**
 * Reset GitHub's 60-day clock. Belt and braces, because GitHub documents the rule ("no repository activity") but not
 * which activity counts: re-enable every watched workflow through the API AND add an empty commit on main (a commit
 * on the default branch is activity by any reading). Either one succeeding is reported as ok.
 */
export async function keepAlive(ctx, { git, now }) {
  const results = [];
  for (const f of WATCHED_WORKFLOWS) results.push({ file: f, ...(await enableWorkflow(ctx, f)) });
  const api = results.every((r) => r.ok);
  const main = ctx.env.MAIN_SHA;
  const branch = ctx.env.DEFAULT_BRANCH || 'main';
  let commit = null;
  let error = null;
  if (main && git) {
    try {
      const tree = (await git(['rev-parse', `${main}^{tree}`])).trim();
      const who = { GIT_AUTHOR_NAME: 'lagerfunk-watchdog', GIT_AUTHOR_EMAIL: 'runner@users.noreply.github.com', GIT_COMMITTER_NAME: 'lagerfunk-watchdog', GIT_COMMITTER_EMAIL: 'runner@users.noreply.github.com' };
      commit = (await git(['commit-tree', tree, '-p', main, '-m', `keepalive ${iso(now)}: no commit for a long time, GitHub stops schedules after 60 days`], { env: who })).trim();
      await git(['push', '--quiet', 'origin', `${commit}:refs/heads/${branch}`]);
    } catch (e) {
      commit = null;
      error = e.message;
    }
  } else error = 'MAIN_SHA is unknown: no keepalive commit';
  const method = [api ? 'api' : null, commit ? 'commit' : null].filter(Boolean).join('+') || 'none';
  return { method, ok: api || Boolean(commit), results, commit, error: api || commit ? null : `API: ${results.map((r) => `${r.file} ${r.status}`).join(', ')}; commit: ${error}` };
}

/** Yesterday's Awin clicks, when AWIN_API_TOKEN and AWIN_PUBLISHER_ID are set. Never throws. */
export async function awinClicks({ env, fetch: fetchImpl, now }) {
  if (!env.AWIN_API_TOKEN || !env.AWIN_PUBLISHER_ID) return { ok: false, error: 'no Awin API token' };
  const date = berlinDate(now - 86400000);
  try {
    const res = await fetchImpl(`https://api.awin.com/publishers/${encodeURIComponent(env.AWIN_PUBLISHER_ID)}/reports/advertiser?startDate=${date}&endDate=${date}&region=DE&timezone=Europe/Berlin`, { headers: { authorization: `Bearer ${env.AWIN_API_TOKEN}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, error: `Awin report http ${res.status}` };
    const rows = await res.json();
    if (!Array.isArray(rows)) return { ok: false, error: 'Awin report: unexpected shape' };
    const byAdvertiser = rows.map((r) => ({ name: r.advertiserName ?? String(r.advertiserId ?? '?'), clicks: Number(r.clicks) || 0 })).filter((r) => r.clicks > 0);
    return { ok: true, date, total: byAdvertiser.reduce((n, r) => n + r.clicks, 0), byAdvertiser };
  } catch (e) {
    return { ok: false, error: `Awin report: ${e.message}` };
  }
}

// ---------- one watchdog run ----------

/**
 * @returns {Promise<{ exitCode: number, wd: object, actions: object[], admin: object, lines: string[] }>}
 */
export async function runWatchdog({ env = process.env, git, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), now: nowFn = () => Date.now(), sleep, out = (l) => console.log(l), root, cfg = null, forceDigest = false } = {}) {
  const now = nowFn();
  const ops = cfg ?? loadOpsConfig({ root });
  const jlog = createJsonLog({ out, secrets: collectSecrets(env), personal: personalValues(env), base: { run: env.GITHUB_RUN_ID ?? null, job: 'watchdog' }, now: nowFn });
  const st = await fetchState({ git });
  let status = null;
  try {
    status = st.status === 'ok' && st.files['status.json'] ? JSON.parse(st.files['status.json']) : null;
  } catch {
    status = null;
  }
  const lines = st.status === 'ok' ? parseActivity(st.files['activity.jsonl']) : [];
  const parsed = st.status === 'ok' ? parseState(st.files['state.json']) : { ok: false, entries: {} };
  const breakers = parsed.ok ? parsed.entries['runner:breakers']?.v ?? null : null;
  const opsB = await readBranch({ git, branch: OPS_BRANCH });
  let wd;
  try {
    wd = loadWatchdog(JSON.parse((await opsB.read(WATCHDOG_FILE)) ?? 'null'));
  } catch {
    wd = loadWatchdog(null);
  }
  const ctx = { env, fetch: fetchImpl };
  const workflows = env.GITHUB_REPOSITORY ? await workflowStates(ctx) : null;
  const idleDays = env.MAIN_COMMIT_TS ? idleDaysFrom(env.MAIN_COMMIT_TS, now) : null;
  const { actions } = evaluateWatchdog({ now, status, wd, workflows, idleDays, cfg: ops, repo: env.GITHUB_REPOSITORY ?? null, forceDigest: forceDigest || /^(1|true|yes|on)$/i.test(String(env.DIGEST_NOW ?? '')) });
  jlog.info('watchdog.start', { status: wd.status, heartbeat: heartbeatOf(status)?.lastGood?.at ?? null, actions: actions.map((a) => a.type) });

  const admin = createAdmin({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_ADMIN_CHAT_ID, apiBase: env.TELEGRAM_API_BASE || undefined, fetch: fetchImpl, now: nowFn, state: wd.admin, cfg: ops, label: 'Lagerfunk watchdog' });
  const set = {};
  const remove = [];
  let backupDate = null;
  let mustReach = false;
  for (const a of actions) {
    if (a.type === 'alert') {
      admin.raise(a.key, a.text, { severity: a.severity });
      if (a.mustReach) mustReach = true;
      jlog[a.severity === 'info' ? 'info' : 'warn']('watchdog.alert', { key: a.key, severity: a.severity });
    } else if (a.type === 'enable') {
      const r = await enableWorkflow(ctx, a.workflow);
      jlog[r.ok ? 'info' : 'error']('watchdog.enable', { workflow: a.workflow, ok: r.ok, status: r.status, error: r.error });
      if (!r.ok) admin.raise(`enable-failed:${a.workflow}`, `[ALERT] Could not switch ${a.workflow} back on (${r.status} ${r.error}). Do it by hand: GitHub, Actions, ${a.workflow}, "Enable workflow". RUNBOOK: Actions disabled.`, { severity: 'critical' });
    } else if (a.type === 'keepalive') {
      const r = await keepAlive(ctx, { git, now });
      wd.keepalive = { lastAt: iso(now), method: r.method, ok: r.ok };
      jlog[r.ok ? 'info' : 'error']('watchdog.keepalive', { method: r.method, ok: r.ok, idleDays: a.idleDays, error: r.error ?? null });
      admin.raise(`keepalive:${berlinDate(now)}`, r.ok ? `[INFO] Main has had no commit for ${a.idleDays} days. Kept the schedules alive (${r.method}).` : `[ALERT] Main has had no commit for ${a.idleDays} days and the keepalive failed (${r.error}). GitHub stops the schedules at 60 days: push any small commit to main. RUNBOOK: Actions disabled.`, { severity: r.ok ? 'info' : 'critical' });
    } else if (a.type === 'backup') {
      if (st.status !== 'ok') continue;
      try {
        const plan = planBackup({ paths: opsB.paths, stateFiles: st.files, date: a.date, keep: ops.backups.keep, stateSha: st.sha, now });
        Object.assign(set, plan.set);
        remove.push(...plan.remove);
        wd.backups = { lastDate: a.date, dates: plan.dates };
        backupDate = a.date;
        jlog.info('backup.planned', { date: a.date, kept: plan.dates, pruned: plan.pruned });
      } catch (e) {
        jlog.error('backup.refused', { error: e.message });
        admin.raise(`backup-refused:${a.date}`, `[ALERT] Daily backup skipped: ${e.message}. RUNBOOK: restore the state.`, { severity: 'critical' });
      }
    } else if (a.type === 'digest') {
      const clicks = await awinClicks({ env, fetch: fetchImpl, now });
      const text = buildDigest({ now, lines, status, breakers, wd, idleDays, cfg: ops, clicks, version: env.CODE_SHA ?? null });
      admin.raise(`digest:${a.date}${forceDigest ? `:${now}` : ''}`, text, { severity: 'info', cooldownMinutes: 0 });
      wd.digestSentFor = a.date;
      jlog.info('digest.queued', { date: a.date, clicks: clicks.ok ? clicks.total : null });
    }
  }

  const flush = await admin.flush();
  if (flush.sent) jlog.info('admin.sent', { sent: flush.sent, keys: flush.keys });
  const criticalLeft = wd.admin.outbox.some((m) => m.sev === 'critical');
  let exitCode = 0;
  if ((criticalLeft || (mustReach && flush.error)) && (!wd.redAt || now - Date.parse(wd.redAt) >= ops.deadman.remindEveryMinutes * MIN)) {
    // The alert did not reach Telegram. A failed run makes GitHub e-mail the owner instead.
    wd.redAt = iso(now);
    exitCode = 1;
    out(`::error::Critical alert not delivered to Telegram (${flush.configured ? flush.error ?? 'pending' : 'TELEGRAM_ADMIN_CHAT_ID not set'}): ${wd.admin.outbox.filter((m) => m.sev === 'critical').map((m) => m.text.split('\n')[0]).join(' | ').slice(0, 500)}`);
  }

  set[WATCHDOG_FILE] = scrub(`${JSON.stringify(wd, null, 1)}\n`, collectSecrets(env)).text; // public branch: same scrub as the state
  try {
    await writeBranch({ git, branch: OPS_BRANCH, base: opsB.ref, set, remove, expectSha: opsB.sha, message: `watchdog ${iso(now)}${backupDate ? ` + backup ${backupDate}` : ''}`, sleep });
  } catch (e) {
    jlog.error('ops.save_failed', { error: e.message });
    out(`::error::watchdog could not save ops branch: ${e.message}`);
    exitCode = 1;
  }
  if (backupDate && exitCode === 0) {
    const back = await readBranch({ git, branch: OPS_BRANCH });
    const ok = parseState(await back.read(`${BACKUP_DIR}/${backupDate}/state.json`)).ok;
    jlog[ok ? 'info' : 'error']('backup.verified', { date: backupDate, ok, dates: backupDates(back.paths) });
    if (!ok) exitCode = 1;
  }
  jlog.info('watchdog.end', { status: wd.status, blind: wd.blind, exitCode, adminSent: flush.sent, adminPending: wd.admin.outbox.length });
  return { exitCode, wd, actions, admin: flush, lines: jlog.lines };
}
