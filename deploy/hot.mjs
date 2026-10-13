#!/usr/bin/env node
// Hot watcher entry point (workflow hot.yml). Runs deploy/config/hot.json for about 50 minutes: NVIDIA FE every 10 s,
// ALTERNATE's RTX 50 listings about once every 10 s in total, retail-price check, drop log on the 'drops' branch, drop
// alerts to the owner's admin chat. Then it starts its own next run. It never orders anything.
//
//   node deploy/hot.mjs --once      one pass over every source, print the drops it would report, send and save nothing
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID, HOT_EXTRA_CHAT_IDS (optional, comma separated: more chats, for example
// a group), HOT_PAUSE (variable: 1 = no checks, no next run), ANNOUNCE (true = send the last drop of every model first),
// GITHUB_TOKEN + GITHUB_REPOSITORY (next run).
import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeHot, runHot, fetchSource, isDrop, loadDb, summaryMessage, telegramSender, HOT_CONFIG_FILE } from './lib/hot.mjs';
import { createHotStore } from './lib/hotstore.mjs';
import { createGithubApi } from './lib/chain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const on = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
const cfg = normalizeHot(JSON.parse(readFileSync(path.join(root, HOT_CONFIG_FILE), 'utf8')));
const fetchImpl = globalThis.fetch.bind(globalThis);

if (process.argv.includes('--once')) {
  for (const src of cfg.sources) {
    const r = await fetchSource(src, { fetch: fetchImpl });
    if (!r.ok) {
      console.log(`${src.id}: failed ${r.error}`);
      continue;
    }
    const inStock = r.products.filter((p) => p.inStock);
    const drops = r.products.filter((p) => isDrop(cfg, p));
    console.log(`${src.id}: ${r.products.length} cards, ${inStock.length} in stock, ${drops.length} at or under ${cfg.models[src.model ?? r.products[0]?.model]?.buyBelow ?? '?'} EUR`);
    for (const p of drops) console.log(`  DROP ${p.title} ${p.price} EUR ${p.url}`);
  }
  process.exit(0);
}

if (on(env.HOT_PAUSE)) {
  console.log('HOT_PAUSE is set: no checks, no next run.');
  process.exit(0);
}
if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_CHAT_ID) {
  console.log('::error::TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID is missing: the watcher would find stock and tell nobody.');
  process.exit(1);
}
const chatIds = [env.TELEGRAM_ADMIN_CHAT_ID, ...String(env.HOT_EXTRA_CHAT_IDS ?? '').split(',')].map((s) => s.trim()).filter(Boolean);
const send = telegramSender({ token: env.TELEGRAM_BOT_TOKEN, chatIds });

const store = createHotStore({ cwd: root, env });
let db;
try {
  db = loadDb(await store.load());
} catch (e) {
  console.log(`::warning::drops.json unreadable (${e.message}); starting a new log`);
  db = loadDb(null);
}
db.firstRunAt ??= new Date().toISOString();

if (on(env.ANNOUNCE)) {
  const r = await send(`[hot watcher] on: NVIDIA FE every 10 s, ALTERNATE RTX 50 listings about every 10 s. A drop = in stock at or under the model's limit. Nothing is bought automatically.\n${summaryMessage(db, cfg)}`);
  console.log(`announce: ${r.ok ? 'sent' : r.error}`);
}

const started = Date.now();
const out = await runHot({ cfg, db, fetch: fetchImpl, send, save: (d) => store.save(d), untilMs: started + cfg.loopMinutes * 60000, log: (l) => console.log(l) });
const rows = Object.entries(out.stats).map(([k, s]) => `${k}: ${s.checks} checks, ${s.fails} failed, ${s.events} drop events`);
console.log(`hot watcher: ${out.sent} messages in ${Math.round((Date.now() - started) / 60000)} min`);
for (const r of rows) console.log(`  ${r}`);
// One line per source as a notice: readable from the run page and the API without downloading the log.
for (const [k, s] of Object.entries(out.stats)) console.log(`::notice title=${k}::${s.checks} checks, ${s.fails} failed, ${s.events} drop events`);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### hot watcher: ${out.sent} messages\n\n${rows.map((r) => `- ${r}`).join('\n')}\n`);

// Start the next run: GitHub's cron drops runs under load, so the chain carries itself (cron in hot.yml is the safety net).
if (env.GITHUB_ACTIONS === 'true') {
  const api = createGithubApi({ env, file: 'hot.yml' });
  const r = await api.dispatch({ ref: env.DEFAULT_BRANCH || 'main' });
  console.log(r.ok ? 'next run started' : `::warning::could not start the next run (${r.status} ${r.error ?? ''}); the cron restarts it`);
}
