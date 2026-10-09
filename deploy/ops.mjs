#!/usr/bin/env node
// Operations by hand or from the ops workflow. Run in a clone of the runner repository (or in the workflow).
//
//   node deploy/ops.mjs status                     heartbeat, breakers, held posts, last posts
//   node deploy/ops.mjs rollback [--to <tag>]      production back to the previous good version (tag last-known-good)
//   node deploy/ops.mjs tag-good --sha <sha>       mark a commit good (the smoke workflow does this)
//   node deploy/ops.mjs backup [--force]           back up the state branch now
//   node deploy/ops.mjs restore --date <YYYY-MM-DD|latest>
//   node deploy/ops.mjs retract [--key <text>|--last]   delete a false post (or edit it into a correction)
//   node deploy/ops.mjs notify --text "<message>"  one message to the admin chat
//   node deploy/ops.mjs digest                     the daily digest now
//   node deploy/ops.mjs promote [--force] [--dry-run] [--repo owner/name]   staging -> public (needs the gh CLI)
//   node deploy/ops.mjs demote [--repo owner/name]                          public -> staging at once
//   node deploy/ops.mjs report --dry-run [--at <ISO time>] [--state-dir <dir> | --repo owner/name] [--watchlist <file>] [--out <dir>]
//                                                  preview the weekly market report from the current state: prints the post,
//                                                  writes deploy/out/report-YYYY-WW.html and .json. Posts nothing, saves nothing
//   node deploy/ops.mjs report [--week 2026-W42] [--state-dir <dir> | --repo owner/name]   export the posted report (for the site)
import { execFile } from 'node:child_process';
import path from 'node:path';
import { createGit } from './lib/gitstate.mjs';
import { ROOT } from './lib/runner.mjs';
import { loadOpsConfig } from './lib/config.mjs';
import { backupNow, restoreState } from './lib/backup.mjs';
import { runWatchdog } from './lib/watchdog.mjs';
import { tagGood, rollback, retract, notify, promote, demote, readRunnerState, reportCommand } from './lib/ops.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const val = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const has = (n) => argv.includes(n);
// the ops workflow passes its free-text input as --arg
const arg = val('--arg');
const env = process.env;
const git = createGit({ cwd: ROOT, env });
const exec = (bin, args) => new Promise((resolve, reject) => execFile(bin, args, { encoding: 'utf8' }, (e, stdout, stderr) => (e ? reject(new Error(stderr || e.message)) : resolve(stdout))));
const print = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 1));

async function main() {
  const cfg = loadOpsConfig({ root: ROOT });
  switch (cmd) {
    case 'status': {
      const s = await readRunnerState({ git });
      if (s.status !== 'ok') return print('no state branch yet');
      const sent = Object.entries(s.ledger).filter(([, e]) => e.s === 'sent').sort((a, b) => a[1].at - b[1].at).slice(-5);
      return print({ health: s.statusJson?.health, channel: s.statusJson?.channel, version: s.statusJson?.version, heartbeat: s.statusJson?.heartbeat, breakers: s.statusJson?.breakers, held: s.held.map((h) => ({ id: h.id, reason: h.reason, at: new Date(h.at).toISOString() })), lastPosts: sent.map(([k, e]) => ({ key: k, at: new Date(e.at).toISOString(), channel: e.ch, messageId: e.m })) });
    }
    case 'rollback': {
      const r = await rollback({ git, to: val('--to') ?? arg });
      await notify({ env, fetch, text: `Lagerfunk: [OPS] rolled back production to ${r.tag} (${r.to.slice(0, 7)}). The next run uses it.` });
      return print(r);
    }
    case 'tag-good':
      return print(await tagGood({ git, sha: val('--sha') ?? arg ?? env.GITHUB_SHA }));
    case 'backup':
      return print(await backupNow({ git, keep: cfg.backups.keep, force: has('--force') }));
    case 'restore': {
      const r = await restoreState({ git, date: val('--date') ?? arg ?? 'latest' });
      await notify({ env, fetch, text: `Lagerfunk: [OPS] state restored from backup ${r.from} (${r.keys} keys, verified). The next run learns silently.` });
      return print(r);
    }
    case 'retract':
      return print(await retract({ git, env, fetch, key: val('--key') ?? (arg && arg !== 'last' ? arg : 'last') }));
    case 'notify': {
      const r = await notify({ env, fetch, text: val('--text') ?? arg ?? '' });
      if (!r.ok) process.exitCode = has('--soft') ? 0 : 1;
      return print(r);
    }
    case 'digest': {
      const r = await runWatchdog({ env, git, root: ROOT, forceDigest: true });
      process.exitCode = r.exitCode;
      return undefined;
    }
    case 'promote': {
      const r = await promote({ git, exec, cfg, force: has('--force'), dryRun: has('--dry-run'), repo: val('--repo') });
      if (!r.ok) process.exitCode = 1;
      return print(r);
    }
    case 'demote': {
      const r = await demote({ exec, repo: val('--repo'), dryRun: has('--dry-run') });
      if (!r.ok) process.exitCode = 1;
      return print(r);
    }
    case 'report': {
      // Never posts: the runner posts the report on its slot. This previews it (--dry-run) or exports the posted one.
      const stateDir = val('--state-dir');
      const r = await reportCommand({
        git, env, root: ROOT, dryRun: has('--dry-run'), week: val('--week') ?? (arg && /^\d{4}-W\d{2}$/.test(arg) ? arg : null), at: val('--at'),
        stateDir: stateDir ? path.resolve(stateDir) : null, repo: val('--repo'), watchlist: val('--watchlist') ? path.resolve(val('--watchlist')) : null, outDir: val('--out') ? path.resolve(val('--out')) : null,
      });
      print(r.text);
      const { text, ...rest } = r;
      return print(rest);
    }
    default:
      print('usage: node deploy/ops.mjs status | rollback [--to tag] | tag-good --sha sha | backup | restore --date YYYY-MM-DD|latest | retract [--key text] | notify --text msg | digest | promote [--force] [--dry-run] | demote | report --dry-run [--at time] [--state-dir dir] | report [--week YYYY-Www]');
      process.exitCode = cmd ? 1 : 0;
  }
  return undefined;
}

try {
  await main();
} catch (e) {
  console.error(env.GITHUB_ACTIONS ? `::error::${e.message}` : `error: ${e.message}`);
  process.exitCode = 1;
}
