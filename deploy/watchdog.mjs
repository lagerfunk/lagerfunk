#!/usr/bin/env node
// Entry point of the watchdog workflow (.github/workflows/watchdog.yml). See lib/watchdog.mjs for what it checks.
// Exit code 1 means: a critical alert could not reach Telegram (GitHub then e-mails the owner), or the ops branch
// could not be saved.
import { runWatchdog } from './lib/watchdog.mjs';
import { createGit } from './lib/gitstate.mjs';
import { ROOT } from './lib/runner.mjs';

try {
  const r = await runWatchdog({ env: process.env, git: createGit({ cwd: ROOT, env: process.env }), root: ROOT, forceDigest: process.argv.includes('--digest') });
  process.exitCode = r.exitCode;
} catch (e) {
  console.error(`::error::watchdog crashed: ${e.message}`);
  process.exitCode = 1;
}
