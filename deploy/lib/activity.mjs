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

export const MAX_ACTIVITY_LINES = 1008; // 6 days at 168 runs a day. About 0.6 MB typical, 1.5 MB at the largest a line gets
export const DAY = 86400000;

export function buildActivity({ at, mode, profile, durationMs, scrapeChecks = [], feedChecks = [], alerts = [], bot = null, feeds = [], shops = {}, state = {}, run = {}, notes = [], ok = true }) {
  const checks = [...scrapeChecks, ...feedChecks];
  const failed = checks.filter((c) => !c.ok);
  const grouped = new Map();
  for (const c of failed) {
    const k = `${c.retailer}\u0000${c.error ?? 'unknown'}`;
    grouped.set(k, (grouped.get(k) ?? 0) + 1);
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
    run: { id: run.id ?? null, attempt: run.attempt ?? null, event: run.event ?? null, sha: run.sha ?? null, idleDays: run.idleDays ?? null },
    notes,
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

/** status.json: the latest run and 24 hour totals, small enough to poll every minute. */
export function buildStatus(lines, nowMs) {
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
  };
}
