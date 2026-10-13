#!/usr/bin/env node
// Hot watcher entry point (workflow hot.yml). Checks deploy/config/hot.json for about 50 minutes, sends hits to the
// owner's private admin chat, then starts its own next run. It never orders anything.
//
//   node deploy/hot.mjs --once      one pass over every item, print the results, send nothing (works on a laptop)
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID (secrets), HOT_PAUSE (variable: 1 = no checks, no next run),
// ANNOUNCE (true = send one "watcher is on" line first), GITHUB_TOKEN + GITHUB_REPOSITORY (to start the next run).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHot, runHot, checkOnce, telegramSender, isHit, HOT_CONFIG_FILE } from './lib/hot.mjs';
import { createGithubApi } from './lib/chain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const on = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const cfg = normalizeHot(JSON.parse(readFileSync(path.join(root, HOT_CONFIG_FILE), 'utf8')));
const fetchImpl = globalThis.fetch.bind(globalThis);

if (process.argv.includes('--once')) {
  for (const item of cfg.items) {
    const r = await checkOnce(item, { fetch: fetchImpl });
    console.log(`${item.key}: ${r.ok ? `${r.inStock ? 'in stock' : 'not in stock'}, ${r.price ?? '?'} EUR${isHit(item, r) ? ', HIT' : ''}` : `failed ${r.error}`}`);
  }
  process.exit(0);
}

if (on(env.HOT_PAUSE)) {
  console.log('HOT_PAUSE is set: no checks, no next run.');
  process.exit(0);
}

const send = telegramSender({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_ADMIN_CHAT_ID });
if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_CHAT_ID) {
  console.log('::error::TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID is missing: the watcher would find stock and tell nobody.');
  process.exit(1);
}
if (on(env.ANNOUNCE)) {
  const fe = cfg.items.filter((i) => i.retailer === 'nvidia').map((i) => `${i.title} every ${i.everySec} s`);
  const r = await send(`[hot watcher] on. ${fe.join(', ')}; ${cfg.items.length - fe.length} partner cards every few minutes. You get a message here the moment one can be ordered under its cap. Nothing is bought automatically.`);
  console.log(`announce: ${r.ok ? 'sent' : r.error}`);
}

const started = Date.now();
const summary = await runHot({ cfg, fetch: fetchImpl, send, untilMs: started + cfg.loopMinutes * 60000, log: (l) => console.log(l) });
console.log(`hot watcher: ${summary.checks} checks, ${summary.sent} messages in ${Math.round((Date.now() - started) / 60000)} min`);
for (const [k, s] of Object.entries(summary.items)) console.log(`  ${k}: ${s.checks} checks, ${s.hits} hits, ${s.fails} failing now`);
if (env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(env.GITHUB_STEP_SUMMARY, `### hot watcher: ${summary.checks} checks, ${summary.sent} messages\n\n${Object.entries(summary.items).map(([k, s]) => `- ${k}: ${s.checks} checks, ${s.hits} hits, ${s.fails} failing`).join('\n')}\n`);
}

// Start the next run: GitHub's cron drops runs under load, so the chain carries itself (cron in hot.yml is the safety net).
if (env.GITHUB_ACTIONS === 'true') {
  const api = createGithubApi({ env, file: 'hot.yml' });
  const r = await api.dispatch({ ref: env.DEFAULT_BRANCH || 'main' });
  console.log(r.ok ? 'next run started' : `::warning::could not start the next run (${r.status} ${r.error ?? ''}); the cron restarts it`);
}
