#!/usr/bin/env node
// Entry point of the lagerfunk workflow: the self-chaining runner. See lib/chain.mjs for the rules.
//
//   node deploy/loop.mjs                 in GitHub Actions: loop for about 50 minutes, one cycle every 10, then start the next run
//   node deploy/loop.mjs --mode watch    on a laptop (no GitHub variables): exactly one cycle, no API calls, no successor
//
// Every cycle is its own `node deploy/run.mjs` process: it reads the state branch, checks, posts, and pushes the state, so a
// crash or a hang in one cycle cannot take the others down. Loop length and interval: deploy/config/breakers.json, "chain".
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGit } from './lib/gitstate.mjs';
import { loadOpsConfig } from './lib/config.mjs';
import { runChain, createGithubApi, spawnCycle, codeVersion } from './lib/chain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const env = { ...process.env };
const i = argv.indexOf('--mode');
if (i >= 0 && argv[i + 1]) env.MODE = argv[i + 1];

let child = null;
for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  process.on(sig, () => {
    child?.kill('SIGTERM');
    process.exit(code);
  });
}

try {
  const ops = loadOpsConfig({ root });
  const inActions = env.GITHUB_ACTIONS === 'true';
  const git = createGit({ cwd: root, env });
  const result = await runChain({
    env,
    chain: ops.chain,
    api: inActions ? createGithubApi({ env }) : null,
    code: inActions ? await codeVersion({ git }) : null,
    runCycle: ({ mode, env: cycleEnv, timeoutMs }) => spawnCycle({ script: path.join(root, 'deploy/run.mjs'), mode, env: cycleEnv, timeoutMs, cwd: root, onChild: (c) => { child = c; } }),
  });
  process.exitCode = result.exitCode;
} catch (e) {
  console.error(inActionsLine(e.message));
  process.exitCode = 1;
}

function inActionsLine(message) {
  return process.env.GITHUB_ACTIONS ? `::error::${message}` : `error: ${message}`;
}
