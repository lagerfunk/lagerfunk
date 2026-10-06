// One short JSON line per run, appended to activity.jsonl on the state branch, plus a small status.json with the latest
// run and the last 24 hours. The agency dashboard reads both from
//   https://raw.githubusercontent.com/<owner>/<repo>/state/activity.jsonl   and   .../state/status.json
// Line schema (v 1). Fields are only ever added:
//   at, mode, profile, durationMs, ok
//   checks   { total, ok, failed, scrape, feed }
//   alerts   { detected, accepted, sent, queued, failed, skipped }
//   errors   [ { retailer, error, n } ]            failed checks grouped by retailer and error code
//   feeds    [ { retailer, status, reason, rows, matched, items, bytes, ms } ]
//   shops    { active, disabled }
//   state    { keys, bytes, pushed, reset }
//   run      { id, attempt, event, sha, idleDays } from GitHub's environment, null elsewhere; idleDays = days since the last commit
//   notes    [string]                              warnings worth a human look
// Added 2026-10-06 (resilience):
//   channel    "staging" | "public"                 where posts went
//   byRetailer { <shop>: [ok, failed] }            checks per shop in this run
//   breakers   { open: [shop], telegram, surge, quarantined, events: [ "trip:retailer:alternate", ... ] }
//   posts      { held, released, duplicates, linkFallbacks }
//   admin      { sent, pending, failed }
//   run.code   the commit that actually ran (the last-known-good tag), next to run.sha (main)

export const MAX_ACTIVITY_LINES = 1008; // 6 days at 168 runs a day. About 0.6 MB typical, 1.5 MB at the largest a line gets
export const DAY = 86400000;

export function buildActivity({ at, mode, profile, durationMs, scrapeChecks = [], feedChecks = [], alerts = [], bot = null, feeds = [], shops = {}, state = {}, run = {}, notes = [], ok = true, extra = {} }) {
  const checks = [...scrapeChecks, ...feedChecks];
  const failed = checks.filter((c) => !c.ok);
  const grouped = new Map();
  for (const c of failed) {
    const k = `${c.retailer}\u0000${c.error ?? 'unknown'}`;
    grouped.set(k, (grouped.get(k) ?? 0) + 1);
  }
  const byRetailer = {}; // compact on purpose: [ok, failed] per shop keeps 6 days of lines under the 2 MB budget
  for (const c of checks) {
    const r = (byRetailer[c.retailer] ??= [0, 0]);
    r[c.ok ? 0 : 1] += 1;
  }
  return {
    v: 1,
    at: new Date(at).toISOString(),
    mode,
    profile,
    durationMs,
    ok,
    checks: { total: checks.length, ok: checks.length - failed.length, failed: failed.length, scrape: scrapeChecks.length, feed: feedChecks.length },
    alerts: { detected: alerts.length, accepted: bot?.accepted?.length ?? 0, sent: bot?.sent?.length ?? 0, queued: bot?.queued ?? 0, failed: bot?.failed?.length ?? 0, skipped: bot?.skipped?.length ?? 0 },
    errors: [...grouped.entries()].map(([k, n]) => {
      const [retailer, error] = k.split('\u0000');
      return { retailer, error, n };
    }),
    feeds: feeds.map((f) => ({ retailer: f.retailer, status: f.status, reason: f.reason ?? null, rows: f.rows ?? 0, matched: f.matched ?? 0, items: f.items ?? 0, bytes: f.bytes ?? 0, ms: f.ms ?? 0 })),
    shops: { active: shops.active ?? 0, disabled: shops.disabled ?? 0 },
    state: { keys: state.keys ?? 0, bytes: state.bytes ?? 0, pushed: state.pushed ?? false, reset: state.reset ?? false },
    run: { id: run.id ?? null, attempt: run.attempt ?? null, event: run.event ?? null, sha: run.sha ?? null, idleDays: run.idleDays ?? null, code: run.code ?? null },
    notes,
    byRetailer,
    ...extra,
  };
}

/** Append a line and keep the newest `max`. Unreadable old lines are dropped, never fatal. */
export function appendActivity(existingText, line, max = MAX_ACTIVITY_LINES) {
  const old = String(existingText ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => {
      if (!l.startsWith('{')) return false;
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });
  const kept = [...old, JSON.stringify(line)].slice(-max);
  return `${kept.join('\n')}\n`;
}

export function parseActivity(text) {
  const out = [];
  for (const l of String(text ?? '').split('\n')) {
    if (!l.trim().startsWith('{')) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* skip a damaged line */
    }
  }
  return out;
}

const beat = (l) => (l ? { at: l.at, ok: l.ok, runId: l.run?.id ?? null, mode: l.mode, checked: l.checks?.total ?? 0, checksOk: l.checks?.ok ?? 0, errors: l.checks?.failed ?? 0, alertsSent: l.alerts?.sent ?? 0, code: l.run?.code ?? l.run?.sha ?? null } : null);

/**
 * The heartbeat the watchdog reads: the last run, the last GOOD run (finished and saved without an error) and the
 * last time any check succeeded. Derived from the activity lines, which hold only runs whose state was saved.
 */
export function buildHeartbeat(lines, nowMs) {
  const last = lines.at(-1) ?? null;
  const lastGood = [...lines].reverse().find((l) => l.ok) ?? null;
  const lastCheckOk = [...lines].reverse().find((l) => (l.checks?.ok ?? 0) > 0) ?? null;
  return {
    lastRun: beat(last),
    lastGood: beat(lastGood),
    lastCheckOkAt: lastCheckOk?.at ?? null,
    minutesSinceGood: lastGood ? Math.round((nowMs - Date.parse(lastGood.at)) / 60000) : null,
  };
}

/**
 * Overall health for the site and the dashboard: "ok", "degraded" (a breaker is open, posts are held, a run failed)
 * or "down" (no good run for too long, or posting is impossible). The site should also treat an updatedAt older than
 * about 40 minutes as "down": this file cannot update itself when the runner is dead.
 */
export function healthOf({ heartbeat, breakers = {}, failedRuns24h = 0, alertAfterMinutes = 40 }) {
  if (!heartbeat?.lastGood || heartbeat.minutesSinceGood > alertAfterMinutes) return 'down';
  if (breakers.telegram === 'open' && breakers.telegramKind === 'auth') return 'down';
  if ((breakers.retailersOpen ?? []).length || (breakers.surgeLatched ?? []).length || breakers.quarantined || (breakers.telegram && breakers.telegram !== 'closed') || !heartbeat.lastRun?.ok || failedRuns24h > 0) return 'degraded';
  return 'ok';
}

/** status.json: the latest run and 24 hour totals, small enough to poll every minute. */
export function buildStatus(lines, nowMs, extras = null) {
  const recent = lines.filter((l) => nowMs - Date.parse(l.at) <= DAY);
  const sum = (f) => recent.reduce((n, l) => n + f(l), 0);
  const last = lines.at(-1) ?? null;
  const byMode = {};
  for (const l of recent) byMode[l.mode] = (byMode[l.mode] ?? 0) + 1;
  const lastOk = [...lines].reverse().find((l) => l.ok);
  return {
    v: 1,
    updatedAt: new Date(nowMs).toISOString(),
    last,
    last24h: {
      runs: recent.length,
      byMode,
      failedRuns: recent.filter((l) => !l.ok).length,
      checks: sum((l) => l.checks.total),
      checksFailed: sum((l) => l.checks.failed),
      alertsDetected: sum((l) => l.alerts.detected),
      alertsSent: sum((l) => l.alerts.sent),
      feedDownloads: sum((l) => l.feeds.filter((f) => f.status === 'ok').length),
      feedBytes: sum((l) => l.feeds.reduce((n, f) => n + f.bytes, 0)),
    },
    lastOkAt: lastOk?.at ?? null,
    // minutes since the newest run: the dashboard can show red when the schedule has stopped
    minutesSinceLastRun: last ? Math.round((nowMs - Date.parse(last.at)) / 60000) : null,
    ...(extras ? statusExtras(lines, nowMs, recent, extras) : {}),
  };
}

function statusExtras(lines, nowMs, recent, { channel = null, version = null, breakers = {}, held = 0, alertAfterMinutes = 40 }) {
  const heartbeat = buildHeartbeat(lines, nowMs);
  const sum = (f) => recent.reduce((n, l) => n + f(l), 0);
  return {
    health: healthOf({ heartbeat, breakers, failedRuns24h: recent.filter((l) => !l.ok).length, alertAfterMinutes }),
    channel,
    version,
    heartbeat,
    breakers: { retailersOpen: breakers.retailersOpen ?? [], telegram: breakers.telegram ?? 'closed', telegramKind: breakers.telegramKind ?? null, surgeLatched: breakers.surgeLatched ?? [], quarantined: breakers.quarantined ?? 0 },
    held,
    posts24h: { held: sum((l) => l.posts?.held ?? 0), duplicates: sum((l) => l.posts?.duplicates ?? 0), linkFallbacks: sum((l) => l.posts?.linkFallbacks ?? 0) },
  };
}
