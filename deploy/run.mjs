#!/usr/bin/env node
// Entry point. See lib/runner.mjs for the modes and what a run does.
import { runOnce } from './lib/runner.mjs';

try {
  const r = await runOnce({ argv: process.argv.slice(2) });
  process.exitCode = r.ok ? 0 : 1;
} catch (e) {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${e.message}` : `error: ${e.message}`);
  process.exitCode = 1;
}
