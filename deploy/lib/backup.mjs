// Daily backups of the state branch, kept on the ops branch as backups/YYYY-MM-DD/{state.json, activity.jsonl,
// status.json, meta.json}. The newest `keep` days stay (7 by default), older days are removed in the same commit.
// A state that does not parse is never backed up, so a corruption cannot push the good copies out.
//
// Restore (node deploy/ops.mjs restore --date 2026-10-05, or --date latest):
//   1. the current state is copied to ops:pre-restore/ first, so the restore itself can be undone,
//   2. the backup becomes the new state branch commit (lease on the sha just read, so a running job cannot clash),
//      with the marker runner:silentOnce: the first run after a restore learns only and posts nothing, because the
//      shops have moved on since the backup and every difference would look like news,
//   3. the result is read back and compared with the backup before the command reports success.
import { fetchState, pushState } from './gitstate.mjs';
import { readBranch, writeBranch, OPS_BRANCH } from './opsbranch.mjs';
import { parseState, serializeState } from './store.mjs';
import { berlinDate } from '../../monitor/src/util.js';

export const BACKUP_DIR = 'backups';
export const BACKUP_FILES = ['state.json', 'activity.jsonl', 'status.json'];
const DATE_RE = new RegExp(`^${BACKUP_DIR}/(\\d{4}-\\d{2}-\\d{2})/`);

/** Dates that have a backup, oldest first. */
export function backupDates(paths = []) {
  return [...new Set(paths.map((p) => DATE_RE.exec(p)?.[1]).filter(Boolean))].sort();
}

/**
 * What to write for today's backup: { set, remove, dates, pruned }. Throws when the state is not readable.
 * @param {object} o
 * @param {string[]} o.paths       every path on the ops branch now
 * @param {object}   o.stateFiles  files of the state branch ({ 'state.json': text, ... })
 */
export function planBackup({ paths = [], stateFiles = {}, date, keep = 7, stateSha = null, now = Date.now() }) {
  const parsed = parseState(stateFiles['state.json']);
  if (!parsed.ok) throw new Error('state.json on the state branch does not parse: not backed up, older backups kept');
  const set = {};
  for (const f of BACKUP_FILES) if (stateFiles[f] !== null && stateFiles[f] !== undefined) set[`${BACKUP_DIR}/${date}/${f}`] = stateFiles[f];
  set[`${BACKUP_DIR}/${date}/meta.json`] = `${JSON.stringify({ date, backedUpAt: new Date(now).toISOString(), stateSavedAt: parsed.savedAt, stateSha, keys: Object.keys(parsed.entries).length }, null, 1)}\n`;
  const dates = [...new Set([...backupDates(paths), date])].sort();
  const kept = dates.slice(-keep);
  const pruned = dates.filter((d) => !kept.includes(d));
  const remove = paths.filter((p) => pruned.includes(DATE_RE.exec(p)?.[1]));
  // files of today's folder from an earlier backup that this one does not write again
  for (const p of paths) if (p.startsWith(`${BACKUP_DIR}/${date}/`) && !(p in set)) remove.push(p);
  return { set, remove, dates: kept, pruned };
}

/** Back up the state branch now (one push to the ops branch). For the ops command; the watchdog folds it into its own push. */
export async function backupNow({ git, now = Date.now(), keep = 7, force = false, sleep }) {
  const st = await fetchState({ git });
  if (st.status !== 'ok') return { status: 'nothing', reason: 'no state branch yet' };
  const ops = await readBranch({ git, branch: OPS_BRANCH });
  const date = berlinDate(now);
  if (!force && backupDates(ops.paths).includes(date)) return { status: 'exists', date };
  const plan = planBackup({ paths: ops.paths, stateFiles: st.files, date, keep, stateSha: st.sha, now });
  await writeBranch({ git, base: ops.ref, set: plan.set, remove: plan.remove, expectSha: ops.sha, message: `backup ${date}`, sleep });
  const check = await verifyBackup({ git, date });
  return { status: 'ok', date, kept: plan.dates, pruned: plan.pruned, verified: check.ok, keys: check.keys };
}

/** Read a backup back and parse it: the proof that it can be restored. */
export async function verifyBackup({ git, date }) {
  const ops = await readBranch({ git, branch: OPS_BRANCH });
  const text = await ops.read(`${BACKUP_DIR}/${date}/state.json`);
  const p = parseState(text);
  return { ok: p.ok, keys: p.ok ? Object.keys(p.entries).length : 0 };
}

/**
 * Restore the state branch from a backup. `date` is YYYY-MM-DD or "latest".
 * @returns {{ from: string, keys: number, stateSha: string, verified: boolean }}
 */
export async function restoreState({ git, date = 'latest', now = Date.now(), sleep }) {
  const ops = await readBranch({ git, branch: OPS_BRANCH });
  const dates = backupDates(ops.paths);
  if (!dates.length) throw new Error('no backups on the ops branch');
  const from = date === 'latest' ? dates.at(-1) : date;
  if (!dates.includes(from)) throw new Error(`no backup for ${from}. Available: ${dates.join(', ')}`);
  const text = await ops.read(`${BACKUP_DIR}/${from}/state.json`);
  const parsed = parseState(text);
  if (!parsed.ok) throw new Error(`the backup of ${from} does not parse: choose another date (${dates.join(', ')})`);

  const cur = await fetchState({ git });
  const curOk = cur.status === 'ok' && parseState(cur.files['state.json']).ok;
  // 1. keep what is there now
  if (cur.status === 'ok' && cur.files['state.json']) {
    await writeBranch({
      git,
      base: ops.ref,
      set: { 'pre-restore/state.json': cur.files['state.json'], 'pre-restore/meta.json': `${JSON.stringify({ savedAt: new Date(now).toISOString(), stateSha: cur.sha, restoredFrom: from }, null, 1)}\n` },
      expectSha: ops.sha,
      message: `pre-restore copy before restoring ${from}`,
      sleep,
    });
  }
  // 2. the backup becomes the state, with one silent run to follow
  const entries = { ...parsed.entries, 'runner:silentOnce': { v: { reason: 'restore', from, at: new Date(now).toISOString() }, exp: 0 } };
  const files = {
    'state.json': serializeState(entries, { savedAt: new Date(now).toISOString(), runId: `restore-${from}` }),
    'state.prev.json': curOk ? cur.files['state.json'] : null,
    'activity.jsonl': (cur.status === 'ok' ? cur.files['activity.jsonl'] : null) ?? (await ops.read(`${BACKUP_DIR}/${from}/activity.jsonl`)),
    'status.json': cur.status === 'ok' ? cur.files['status.json'] : null,
  };
  const pushed = await pushState({ git, files, expectSha: cur.status === 'ok' ? cur.sha : null, message: `restore state from backup ${from}`, sleep });
  // 3. read it back
  const back = await fetchState({ git });
  const got = parseState(back.files['state.json']);
  const same = got.ok && Object.keys(parsed.entries).every((k) => JSON.stringify(got.entries[k]) === JSON.stringify(parsed.entries[k]));
  if (!same) throw new Error('restore pushed, but the state read back does not match the backup. Do not run again: open the ops branch pre-restore/ copy and compare.');
  return { from, keys: Object.keys(parsed.entries).length, stateSha: pushed.sha, verified: true };
}
