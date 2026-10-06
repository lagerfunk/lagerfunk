// Post-deploy smoke test. Two parts, both fail closed (any doubt is a failure, and a failure means the change does
// not become last-known-good, so production keeps running the previous version):
//
//   offline  the bundle runs end to end against generated fixtures: a PS Direct API answer and an Awin feed, a fake
//            Telegram server, a temporary state. It walks through baseline, a restock posted to the STAGING chat
//            only, a duplicate that must not post, a surge that must be held, a wrong price that must be held and
//            kept out of the history, the heartbeat, the watchdog decision, and a full backup and restore drill on a
//            temporary git repository.
//   live     one dry run against the real shops (reads pages politely, posts nothing, saves nothing), and read-only
//            Telegram calls (getMe, getChat, getChatMember) for the target channel and the admin chat.
//
// Everything here is in the public bundle and needs no npm install.
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runOnce, gitBackend, ROOT } from './runner.mjs';
import { createGit, fetchState, pushState } from './gitstate.mjs';
import { parseState } from './store.mjs';
import { backupNow, restoreState } from './backup.mjs';
import { evaluateWatchdog, loadWatchdog } from './watchdog.mjs';
import { loadOpsConfig } from './config.mjs';
import { collectSecrets, scrub } from './secrets.mjs';
import { parseJsonLines } from './log.mjs';
import { resolveChannel } from './stage.mjs';

const MIN = 60000;

/** A tiny Telegram Bot API stand-in on 127.0.0.1. Records every call. */
export async function startFakeTelegram() {
  const calls = [];
  const script = [];
  let id = 1;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const method = /\/bot[^/]+\/(\w+)$/.exec(req.url)?.[1] ?? '?';
      calls.push({ method, body });
      const i = script.findIndex((s) => s.method === method);
      const s = i >= 0 ? script.splice(i, 1)[0] : null;
      res.writeHead(s?.status ?? 200, { 'content-type': 'application/json' });
      if (s) return res.end(JSON.stringify(s.body));
      if (method === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 7, is_bot: true, username: 'lagerfunk_smoke_bot' } }));
      if (method === 'getChat') return res.end(JSON.stringify({ ok: true, result: { id: -1001, type: 'channel', title: 'smoke' } }));
      if (method === 'getChatMember') return res.end(JSON.stringify({ ok: true, result: { status: 'administrator', can_post_messages: true } }));
      if (method === 'getUpdates') return res.end(JSON.stringify({ ok: true, result: [] }));
      return res.end(JSON.stringify({ ok: true, result: { message_id: id++, chat: { id: body.chat_id } } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    calls,
    script: (method, status, body) => script.push({ method, status, body }),
    sends: (chat) => calls.filter((c) => (c.method === 'sendMessage' || c.method === 'sendPhoto') && (chat === undefined || String(c.body.chat_id) === String(chat))),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

const PSD_URL = 'https://direct.playstation.com/de-de/buy-consoles/playstation5-pro-console-2-tb';
const psdJson = (stock, price = 899.99) => JSON.stringify({ products: [{ code: '1000050720-DE', name: 'PlayStation 5 Pro Konsole - 2 TB', purchasable: true, stock: { stockLevelStatus: stock ? 'inStock' : 'outOfStock' }, price: { currencyIso: 'EUR', value: price }, preOrderProduct: false, maxOrderQuantity: stock ? 1 : 0, validProductCode: true }] });
const FEED_COLS = ['aw_deep_link', 'product_name', 'aw_product_id', 'merchant_product_id', 'search_price', 'merchant_name', 'merchant_id', 'currency', 'merchant_deep_link', 'ean', 'in_stock', 'stock_status', 'stock_quantity', 'is_for_sale', 'condition'];
export const SMOKE_ITEMS = [
  { productKey: 'ps5-pro', retailer: 'psdirect', url: PSD_URL, sku: '1000050720-DE', threshold: 989.99, listPrice: 899.99, listPriceType: 'uvp', intervalSec: 60 },
  ...Array.from({ length: 8 }, (_, i) => ({ productKey: `smoke-${i}`, retailer: 'proshop', url: `https://www.proshop.de/Grafikkarte/Smoke-${i}/${3400000 + i}`, ean: `40000000${10000 + i}`, threshold: 2000, listPrice: 999, title: `Smoke GPU ${i}`, intervalSec: 3600 })),
];
/** Awin classic CSV for the smoke items: rows = [{ i, inStock, price }]. */
export function smokeFeed(rows) {
  const lines = rows.map(({ i, inStock, price = 899 }) => [
    `https://www.awin1.com/pclick.php?p=${9000 + i}&a=111111&m=18501`, `Smoke GPU ${i}`, String(9000 + i), String(3400000 + i), price.toFixed(2), 'Proshop', '18501', 'EUR',
    `https://www.proshop.de/Grafikkarte/Smoke-${i}/${3400000 + i}`, `40000000${10000 + i}`, inStock ? '1' : '0', inStock ? 'in stock' : 'out of stock', inStock ? '5' : '0', '1', 'new',
  ].join(','));
  return `${FEED_COLS.join(',')}\n${lines.join('\n')}\n`;
}

const SMOKE_TOKEN = 'smoke-fake-token-not-a-bot-token';
const FEED_KEY = 'SMOKEKEY0123456789abcdef';
const STAGING = '-1009990001112';
const ADMIN = '987654321';

/**
 * @returns {Promise<{ ok: boolean, steps: { name: string, ok: boolean, detail?: any, error?: string }[] }>}
 */
export async function smokeOffline({ root = ROOT, keep = false } = {}) {
  const steps = [];
  const step = async (name, fn) => {
    try {
      steps.push({ name, ok: true, detail: (await fn()) ?? null });
    } catch (e) {
      steps.push({ name, ok: false, error: e.message });
    }
  };
  const must = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const tmp = mkdtempSync(path.join(tmpdir(), 'lagerfunk-smoke-'));
  const tg = await startFakeTelegram();
  const ops = loadOpsConfig({ root });
  const wl = path.join(tmp, 'watchlist.json');
  writeFileSync(wl, JSON.stringify({ items: SMOKE_ITEMS }));
  const world = { psd: false, psdPrice: 899.99, feed: SMOKE_ITEMS.slice(1).map((_, i) => ({ i, inStock: false, price: 899 })) };
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.startsWith(tg.base)) return globalThis.fetch(url, init);
    if (u.includes('api.direct.playstation.com')) return new Response(psdJson(world.psd, world.psdPrice), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.startsWith('https://productdata.awin.com/')) return new Response(smokeFeed(world.feed), { status: 200, headers: { 'content-type': 'text/csv' } });
    return new Response('no route in the smoke test', { status: 599 });
  };
  const env = {
    PROFILE: 'free', TELEGRAM_BOT_TOKEN: SMOKE_TOKEN, TELEGRAM_API_BASE: tg.base, LAGERFUNK_CHANNEL: 'staging', TELEGRAM_CHAT_ID_STAGING: STAGING, TELEGRAM_ADMIN_CHAT_ID: ADMIN,
    FEED_URL_PROSHOP: `https://productdata.awin.com/datafeed/download/apikey/${FEED_KEY}/language/de/fid/1/format/csv/`, FEED_FORMAT_PROSHOP: 'awin-csv', AWIN_AFFILIATE_ID: '111111', DAILY_REPORT: 'off',
  };
  const secrets = collectSecrets(env);
  const allOutput = [];
  let t = Date.parse('2026-11-20T09:00:00Z');
  const stateDir = path.join(tmp, 'state');
  const run = async (advanceMin) => {
    t += advanceMin * MIN;
    const lines = [];
    let clock = t + 2000;
    const r = await runOnce({
      root, env, fetch: fetchImpl, now: () => t, sleep: async () => {}, jitterMs: 0, opsConfig: ops, out: (l) => { lines.push(l); allOutput.push(l); },
      argv: ['--mode', 'all', '--force', '--watchlist', wl, '--state-dir', stateDir, '--out', path.join(tmp, 'out')],
      clock: { now: () => clock, sleep: async (ms) => { clock += ms; } },
    });
    return { ...r, lines };
  };
  try {
    await step('baseline run: everything out of stock, nothing posted, heartbeat written', async () => {
      const r = await run(0);
      must(r.ok, `run failed: ${r.lines.filter((l) => /ERROR|error/.test(l)).join(' | ')}`);
      must(tg.sends().length === 0, 'something was posted');
      const status = JSON.parse(readFileSync(path.join(stateDir, 'status.json'), 'utf8'));
      must(status.heartbeat?.lastGood?.at === new Date(t).toISOString(), 'heartbeat.lastGood is not this run');
      must(status.channel === 'staging', `status.channel is ${status.channel}`);
      return { checks: r.activity.checks.total };
    });
    await step('restock: posted to the staging chat only, feed post labelled Anzeige with our tag', async () => {
      world.psd = true;
      world.feed[0].inStock = true;
      const r = await run(61);
      must(r.ok, `run failed: ${JSON.stringify(r.activity?.notes)}`);
      const staged = tg.sends(STAGING);
      must(staged.length === 2, `${staged.length} posts to staging, expected 2`);
      must(tg.sends().length === 2, 'a post went somewhere other than the staging chat');
      const feedPost = staged.find((c) => /awin1\.com/.test(c.body.text));
      must(feedPost && feedPost.body.text.startsWith('<b>Anzeige</b>'), 'the feed post lacks "Anzeige" or the tracked link');
      must(/a=111111/.test(feedPost.body.text), 'the feed post does not carry our publisher id');
      must(staged.every((c) => !/\u2014/.test(c.body.text)), 'em dash in a post');
      return { posts: staged.length };
    });
    await step('duplicate: the same restock again inside the window is not posted twice', async () => {
      world.psd = false;
      await run(21);
      world.psd = true;
      const before = tg.sends().length;
      const r = await run(21);
      must(r.alerts.some((a) => a.retailer === 'psdirect'), 'the monitor did not re-detect the restock (test setup)');
      must(tg.sends().length === before, 'the duplicate was posted');
      must(r.activity.posts.duplicates >= 1, 'no duplicate counted');
      return { duplicates: r.activity.posts.duplicates };
    });
    await step('surge: 7 products flip to in stock at once, every post held, admin alerted', async () => {
      for (let i = 1; i < 8; i++) world.feed[i].inStock = true;
      const before = tg.sends(STAGING).length;
      const r = await run(61);
      must(tg.sends(STAGING).length === before, 'a post went out during a surge');
      must(r.activity.posts.held === 7, `${r.activity.posts.held} held, expected 7`);
      must(tg.sends(ADMIN).some((c) => /flipped to in stock/.test(c.body.text)), 'no surge alert in the admin chat');
      return { held: r.activity.posts.held };
    });
    await step('price sanity: a price at 10 % of the reference is held and kept out of the history', async () => {
      const histBefore = parseState(readFileSync(path.join(stateDir, 'state.json'), 'utf8')).entries['hist:proshop:smoke-0'];
      world.feed[0].price = 89.9;
      const before = tg.sends(STAGING).length;
      const r = await run(61);
      must(tg.sends(STAGING).length === before, 'the wrong price was posted');
      must(r.held.some((h) => /^price:/.test(h.reason)), 'no price hold recorded');
      const histAfter = parseState(readFileSync(path.join(stateDir, 'state.json'), 'utf8')).entries['hist:proshop:smoke-0'];
      must(JSON.stringify(histAfter) === JSON.stringify(histBefore), 'the wrong price reached the 30-day history');
      must(tg.sends(ADMIN).some((c) => /looks wrong/.test(c.body.text)), 'no price alert in the admin chat');
      world.feed[0].price = 899;
      return { quarantined: Object.keys(r.breakers.quarantine) };
    });
    await step('logs: JSON lines parse, no secret and no personal id anywhere in output or state', async () => {
      const json = parseJsonLines(allOutput);
      must(json.length > 10, 'too few JSON log lines');
      must(json.every((j) => j.ts && j.lvl && j.ev), 'a JSON line lacks ts, lvl or ev');
      const text = allOutput.join('\n') + readFileSync(path.join(stateDir, 'state.json'), 'utf8') + readFileSync(path.join(stateDir, 'activity.jsonl'), 'utf8');
      must(scrub(text, secrets).count === 0, 'a secret value leaked');
      must(!allOutput.join('\n').includes(ADMIN) && !allOutput.join('\n').includes(STAGING), 'a chat id leaked into the log');
      return { jsonLines: json.length };
    });
    await step('watchdog: 41 minutes without a good run alerts, a fresh heartbeat recovers', async () => {
      const status = JSON.parse(readFileSync(path.join(stateDir, 'status.json'), 'utf8'));
      const wd = loadWatchdog(null);
      const a = evaluateWatchdog({ now: t + 41 * MIN, status, wd, cfg: ops });
      must(a.actions.some((x) => x.type === 'alert' && /^deadman:/.test(x.key)), 'no dead-man alert at 41 minutes');
      const b = evaluateWatchdog({ now: t + 39 * MIN, status: { ...status, heartbeat: { ...status.heartbeat, lastGood: { ...status.heartbeat.lastGood, at: new Date(t + 38 * MIN).toISOString() } } }, wd: a.wd, cfg: ops });
      must(b.actions.some((x) => x.type === 'alert' && /^deadman-recover:/.test(x.key)), 'no recovery notice');
      return null;
    });
    await step('backup and restore drill on a temporary git repository', async () => {
      const g = path.join(tmp, 'git');
      const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
      const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: gitEnv });
      sh(tmp, 'init', '--bare', '-q', '-b', 'main', `${g}.git`);
      sh(tmp, 'init', '-q', '-b', 'main', g);
      writeFileSync(path.join(g, 'README.md'), 'smoke\n');
      sh(g, 'add', '.');
      sh(g, '-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-q', '-m', 'init');
      sh(g, 'remote', 'add', 'origin', `file://${g}.git`);
      sh(g, 'push', '-q', 'origin', 'main');
      const git = createGit({ cwd: g, env: gitEnv });
      const files = Object.fromEntries(['state.json', 'state.prev.json', 'activity.jsonl', 'status.json'].map((f) => { try { return [f, readFileSync(path.join(stateDir, f), 'utf8')]; } catch { return [f, null]; } }));
      await pushState({ git, files, expectSha: null, message: 'smoke state', sleep: async () => {} });
      const good = parseState(files['state.json']);
      const b = await backupNow({ git, now: t, keep: ops.backups.keep, sleep: async () => {} });
      must(b.status === 'ok' && b.verified, `backup: ${JSON.stringify(b)}`);
      const cur = await fetchState({ git });
      await pushState({ git, files: { 'state.json': '{"v":1,"entries":{ broken', 'activity.jsonl': files['activity.jsonl'] }, expectSha: cur.sha, message: 'corrupt on purpose', sleep: async () => {} });
      const r = await restoreState({ git, date: 'latest', now: t, sleep: async () => {} });
      must(r.verified, 'restore not verified');
      const back = parseState((await fetchState({ git })).files['state.json']);
      must(back.ok && Object.keys(good.entries).every((k) => JSON.stringify(back.entries[k]) === JSON.stringify(good.entries[k])), 'restored state differs from the backup');
      must(back.entries['runner:silentOnce'], 'the restore did not mark the next run silent');
      const lines = [];
      const after = await runOnce({ root, env, fetch: fetchImpl, now: () => t + MIN, sleep: async () => {}, jitterMs: 0, opsConfig: ops, out: (l) => lines.push(l), git, backend: gitBackend({ git, sleep: async () => {} }), argv: ['--mode', 'watch', '--watchlist', wl, '--out', path.join(tmp, 'out2')] });
      must(after.ok, `the run after the restore failed: ${lines.join(' | ').slice(0, 400)}`);
      must(after.activity.notes.some((n) => /after a state restore/.test(n)), 'the run after the restore was not silent');
      return { restoredFrom: r.from, keys: r.keys };
    });
  } finally {
    await tg.close();
    if (!keep) rmSync(tmp, { recursive: true, force: true });
  }
  return { ok: steps.every((s) => s.ok), steps };
}

async function tgCall(env, fetchImpl, method, body) {
  const base = (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
  const res = await fetchImpl(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(`${method}: ${data?.error_code ?? res.status} ${data?.description ?? ''}`.trim());
  return data.result;
}

/**
 * The live part. Reads shops (dry run: posts nothing, saves nothing) and checks Telegram read-only.
 */
export async function smokeLive({ env = process.env, root = ROOT, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), now = () => Date.now(), sleep, jitterMs, watchlistPath = null } = {}) {
  const ops = loadOpsConfig({ root });
  const steps = [];
  const step = async (name, fn) => {
    try {
      steps.push({ name, ok: true, detail: (await fn()) ?? null });
    } catch (e) {
      steps.push({ name, ok: false, error: e.message });
    }
  };
  const must = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const tmp = mkdtempSync(path.join(tmpdir(), 'lagerfunk-live-'));
  const secrets = collectSecrets(env);
  const lines = [];
  try {
    await step('live dry run against the real shops: no crash, enough checks succeed, nothing posted or saved', async () => {
      const r = await runOnce({ root, env: { ...env, DRY_RUN: '1', MODE: 'watch' }, fetch: fetchImpl, now, ...(sleep ? { sleep } : {}), ...(jitterMs !== undefined ? { jitterMs } : {}), out: (l) => lines.push(l), argv: ['--mode', 'watch', '--dry-run', '--state-dir', path.join(tmp, 'state'), '--out', path.join(tmp, 'out'), ...(watchlistPath ? ['--watchlist', watchlistPath] : [])] });
      must(r.ok, `dry run failed: ${(r.activity?.notes ?? []).join(' | ').slice(0, 400)}`);
      must(r.activity.checks.total > 0, 'no shop was checked: nothing is switched on, or the run broke');
      must(r.activity.checks.ok >= ops.smoke.minOkChecks, `${r.activity.checks.ok} of ${r.activity.checks.total} checks succeeded, need ${ops.smoke.minOkChecks}. Errors: ${JSON.stringify(r.activity.errors).slice(0, 300)}`);
      must(r.activity.state.pushed === false, 'the dry run saved state');
      return { checks: r.activity.checks, errors: r.activity.errors };
    });
    await step('no secret in the output', async () => {
      must(scrub(lines.join('\n'), secrets).count === 0, 'a secret value appeared in the log');
      return null;
    });
    await step('Telegram: the bot token works, the target channel and the admin chat are reachable (read only)', async () => {
      must(env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN is not set: the deploy cannot post');
      const me = await tgCall(env, fetchImpl, 'getMe', {});
      const ch = resolveChannel(env);
      const target = ch.channel === 'staging' ? env.TELEGRAM_CHAT_ID_STAGING : env.FREE_CHAT_ID || '@lagerfunk';
      must(target, `channel ${ch.channel} has no chat id`);
      await tgCall(env, fetchImpl, 'getChat', { chat_id: target });
      const member = await tgCall(env, fetchImpl, 'getChatMember', { chat_id: target, user_id: me.id });
      must(member.status === 'administrator' || member.status === 'creator', `the bot is "${member.status}" in the ${ch.channel} channel, it must be an administrator`);
      must(member.can_post_messages !== false, `the bot may not post in the ${ch.channel} channel`);
      const admin = env.TELEGRAM_ADMIN_CHAT_ID ? await tgCall(env, fetchImpl, 'getChat', { chat_id: env.TELEGRAM_ADMIN_CHAT_ID }).then(() => 'reachable') : 'not set';
      must(admin === 'reachable', 'TELEGRAM_ADMIN_CHAT_ID is not set: nobody would hear an alert');
      return { bot: me.username, channel: ch.channel, admin };
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { ok: steps.every((s) => s.ok), steps };
}
