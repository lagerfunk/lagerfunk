// Drop Radar posting engine. Runtime-neutral: plain ES modules, fetch, no Node APIs.
//
// Model: one state document in the Store (key `${prefix}state`) holds the outbox (delayed-post queue),
// per-channel dedupe hashes, rate windows, cooldowns and the day log. Every send is bracketed by writes:
//   persist(job marked in-flight) -> send -> persist(job removed). One write per send in steady state,
// because the "removed" write of job N is the "in-flight" write of job N+1.
// A job found still in-flight after a crash is never resent (strict "never twice per channel").
import { realClock, keyHash, toMs, berlinDate, berlinTime, berlinHour, parsePrice, isHttpUrl, truncate, escapeHtml } from './util.js';
import { loadConfig, effectivePaid, configWarnings } from './config.js';
import { resolveRetailer, buildLink } from './affiliate.js';
import { priceFacts } from './pricing.js';
import { renderAlertPost, renderDailyReport, delayText } from './format.js';
import { startText, channelDescription, pinnedPost } from './copy.js';
import { createTelegram, createDiscord, SendError, visibleLength } from './telegram.js';
import { guardLink } from './linkcheck.js';

const PRIORITY = { instant: 0, free: 1, discord: 2 };
const KINDS = new Set(['restock', 'price_drop', 'lowest_30d', 'ships_before']);
const MIN = 60000;
const DAY = 86400000;
const MAX_SEEN_PER_TARGET = 5000;
const MAX_LOG = 400;
const MAX_ERRORS = 20;

function emptyState() {
  return {
    v: 1, rev: 0, outbox: [], seen: {}, cool: {}, rate: {}, log: [],
    counts: { date: '', by: {} }, errors: [], reportSent: '', reportAt: 0,
    lease: null, hb: 0, lastPost: null, updOffset: 0, chatMap: {}, pinned: {}, once: {},
  };
}

// Ready-made posts (the weekly market report) are accepted once per id and target, ever: `once` remembers them this long.
const ONCE_KEEP_MS = 60 * DAY;

function slimAlert(a) {
  const pick = ['key', 'kind', 'productKey', 'retailer', 'title', 'url', 'price', 'listPrice', 'lowest30d', 'detectedAt',
    'imageUrl', 'inStock', 'stockText', 'listPriceType', 'lowest30dSource', 'historyDays', 'firstSeenAt',
    'deliveryEstimate', 'deliveryAssumed', 'isPreorder', 'isBackorder', 'shipsBy', 'soldBy', 'shopUrl'];
  const o = {};
  for (const k of pick) if (a[k] !== undefined && a[k] !== null) o[k] = a[k];
  o.title = truncate(o.title || a.productKey || 'Produkt', 200);
  return o;
}

function plainFromHtml(html) {
  return String(html)
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2: $1')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function createEngine({ store, monitorStore = null, config, env, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), clock = realClock, log = console, owner, linkGuard = guardLink } = {}) {
  if (!store) throw new Error('createEngine: store is required');
  const cfg = config ?? loadConfig(env ?? {});
  const KEY = `${cfg.storePrefix}state`;
  const me = owner || `run-${Math.random().toString(36).slice(2, 10)}`;
  const tg = createTelegram({ token: cfg.telegramToken, apiBase: cfg.telegramApiBase, fetch: fetchImpl, timeoutMs: cfg.httpTimeoutMs });
  const discord = cfg.discordWebhookUrl ? createDiscord({ url: cfg.discordWebhookUrl, fetch: fetchImpl, timeoutMs: cfg.httpTimeoutMs, username: cfg.brand }) : null;

  // Links that failed the affiliate check in this run (the post went out with the plain shop link instead).
  let linkEvents = [];
  function checkedLink(link, alert, retailer, where) {
    const out = linkGuard(link, { alert, retailer, cfg });
    if (!out) {
      linkEvents.push({ key: alert.key ?? where, retailer: retailer?.id ?? null, reason: 'link:none', action: 'dropped' });
      return null;
    }
    if (out.checked === 'fallback') linkEvents.push({ key: alert.key ?? where, retailer: retailer?.id ?? null, reason: out.reason, action: 'plain' });
    return out;
  }

  // ---------- serialisation inside one process/isolate ----------
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  // ---------- targets and timing ----------
  const paid = () => effectivePaid(cfg);
  const configured = (t) => (t === 'discord' ? Boolean(discord) : Boolean(cfg.channels?.[t]?.chatId));
  const tierOf = (t) => (t === 'discord' ? (cfg.discordTier === 'instant' ? 'instant' : 'free') : t);
  const delayed = (t) => paid() && tierOf(t) === 'free';
  const activeTargets = () => ['instant', 'free', 'discord'].filter(configured);
  const delayMs = () => Math.max(0, Number(cfg.freeDelaySec) || 0) * 1000;
  // A closed channel (only when the paid flag is on). Amazon links there must not carry the partner tag.
  const isPrivate = (t) => paid() && tierOf(t) === 'instant';

  // ---------- state load / persist (with merge for concurrent writers) ----------
  async function load() {
    const raw = await store.get(KEY);
    const state = { ...emptyState(), ...(raw && typeof raw === 'object' ? raw : {}) };
    return { state, baseRev: state.rev || 0, dirty: false, done: new Set(), holdsLease: false };
  }

  function merge(ours, theirs, done) {
    for (const [t, m] of Object.entries(theirs.seen || {})) {
      ours.seen[t] ??= {};
      for (const [h, exp] of Object.entries(m)) ours.seen[t][h] = Math.max(ours.seen[t][h] || 0, exp);
    }
    const have = new Set(ours.outbox.map((j) => j.id));
    for (const j of theirs.outbox || []) if (!have.has(j.id) && !done.has(j.id)) ours.outbox.push(j);
    for (const [t, m] of Object.entries(theirs.cool || {})) {
      ours.cool[t] ??= {};
      for (const [h, c] of Object.entries(m)) if (!ours.cool[t][h] || ours.cool[t][h].at < c.at) ours.cool[t][h] = c;
    }
    const logIds = new Set(ours.log.map((e) => e.id));
    for (const e of theirs.log || []) if (!logIds.has(e.id)) ours.log.push(e);
    if ((theirs.reportSent || '') > (ours.reportSent || '')) { ours.reportSent = theirs.reportSent; ours.reportAt = theirs.reportAt; }
    if (theirs.counts?.date === ours.counts.date) {
      for (const [t, n] of Object.entries(theirs.counts.by || {})) ours.counts.by[t] = Math.max(ours.counts.by[t] || 0, n);
    }
    ours.chatMap = { ...(theirs.chatMap || {}), ...ours.chatMap };
    ours.pinned = { ...(theirs.pinned || {}), ...(ours.pinned || {}) };
    ours.pinnedChat = { ...(theirs.pinnedChat || {}), ...(ours.pinnedChat || {}) };
    ours.once = { ...(theirs.once || {}), ...(ours.once || {}) };
    ours.updOffset = Math.max(ours.updOffset || 0, theirs.updOffset || 0);
    if (theirs.lease && theirs.lease.owner !== me && !ours.lease) ours.lease = theirs.lease;
  }

  async function persist(ctx) {
    const cur = await store.get(KEY);
    if (cur && typeof cur === 'object' && (cur.rev || 0) !== ctx.baseRev) merge(ctx.state, cur, ctx.done);
    ctx.state.rev = Math.max(cur?.rev || 0, ctx.state.rev || 0) + 1;
    ctx.state.outbox.sort((a, b) => a.due - b.due);
    await store.put(KEY, ctx.state);
    ctx.baseRev = ctx.state.rev;
    ctx.dirty = false;
  }

  function recordError(ctx, now, where, err) {
    const msg = truncate(String(err?.message || err), 200);
    ctx.state.errors.push({ at: now, where, msg });
    if (ctx.state.errors.length > MAX_ERRORS) ctx.state.errors.splice(0, ctx.state.errors.length - MAX_ERRORS);
    ctx.dirty = true;
    log?.warn?.(`[drop-radar] ${where}: ${msg}`);
  }

  function bumpCount(ctx, now, t) {
    const date = berlinDate(now);
    if (ctx.state.counts.date !== date) ctx.state.counts = { date, by: {} };
    ctx.state.counts.by[t] = (ctx.state.counts.by[t] || 0) + 1;
  }

  // ---------- housekeeping ----------
  function prune(ctx, now) {
    const s = ctx.state;
    for (const t of Object.keys(s.seen)) {
      const entries = Object.entries(s.seen[t]).filter(([, exp]) => exp > now);
      if (entries.length > MAX_SEEN_PER_TARGET) entries.sort((a, b) => a[1] - b[1]).splice(0, entries.length - MAX_SEEN_PER_TARGET);
      if (entries.length !== Object.keys(s.seen[t]).length) ctx.dirty = true;
      s.seen[t] = Object.fromEntries(entries);
    }
    const coolMs = cfg.productCooldownSec * 1000;
    for (const t of Object.keys(s.cool)) {
      for (const [h, c] of Object.entries(s.cool[t])) if (now - c.at > coolMs) { delete s.cool[t][h]; ctx.dirty = true; }
    }
    const before = s.log.length;
    s.log = s.log.filter((e) => now - e.at < 2 * DAY).slice(-MAX_LOG);
    if (s.log.length !== before) ctx.dirty = true;
    if (s.errors.length && now - s.errors[0].at > 7 * DAY) { s.errors = s.errors.filter((e) => now - e.at <= 7 * DAY); ctx.dirty = true; }
    for (const [t, r] of Object.entries(s.rate)) r.ts = (r.ts || []).filter((x) => now - x < MIN);
    s.once ??= {};
    for (const [id, at] of Object.entries(s.once)) if (now - at > ONCE_KEEP_MS) { delete s.once[id]; ctx.dirty = true; }

    // Crash recovery: a job still marked in-flight from a dead run may already be on Telegram.
    for (const j of [...s.outbox]) {
      if (!j.inf || (s.lease && s.lease.owner === me)) continue;
      if (s.lease && s.lease.owner !== me && s.lease.until > now) continue; // another live run owns it
      if (cfg.retryUnknownOutcome) { delete j.inf; }
      else { dropJob(ctx, j, now, 'in-flight bei Absturz, nicht erneut gesendet (Doppelpost-Schutz)'); }
      ctx.dirty = true;
    }
    // Queue overflow guard: drop the oldest free/discord jobs first.
    if (s.outbox.length > cfg.maxOutbox) {
      const victims = [...s.outbox].sort((a, b) => (PRIORITY[b.t] - PRIORITY[a.t]) || (a.c - b.c)).slice(0, s.outbox.length - cfg.maxOutbox);
      for (const v of victims) dropJob(ctx, v, now, 'Warteschlange voll');
    }
  }

  // ---------- ingest ----------
  function validate(a) {
    if (!a || typeof a !== 'object') return 'kein Objekt';
    if (!a.key) return 'key fehlt';
    if (!KINDS.has(a.kind)) return `kind unbekannt: ${a.kind}`;
    if (!isHttpUrl(a.url)) return 'url ungültig';
    return null;
  }

  function ingest(ctx, alerts, now) {
    const res = { accepted: [], skipped: [] };
    const targets = activeTargets();
    for (const raw of alerts || []) {
      const bad = validate(raw);
      if (bad) { res.skipped.push({ key: raw?.key, reason: bad }); continue; }
      const a = slimAlert(raw);
      const detected = toMs(a.detectedAt, now);
      if (now - detected > cfg.staleAfterSec * 1000) { res.skipped.push({ key: a.key, reason: 'zu alt' }); continue; }
      if (cfg.skipOutOfStock && a.inStock === false) { res.skipped.push({ key: a.key, reason: 'ausverkauft' }); continue; }
      const h = keyHash(a.key);
      // productKey is unique per retailer only, so the cooldown key is retailer + productKey.
      const ph = keyHash(`${a.retailer || ''}|${a.productKey || a.url}`);
      const price = parsePrice(a.price);
      let queuedAny = false;
      for (const t of targets) {
        ctx.state.seen[t] ??= {};
        ctx.state.cool[t] ??= {};
        if (ctx.state.seen[t][h]) { res.skipped.push({ key: a.key, target: t, reason: 'schon gepostet' }); continue; }
        // Same product posted a few minutes ago: only post again if the news got better
        // (now ships in time, or a lower price).
        const c = ctx.state.cool[t][ph];
        if (c && now - c.at < cfg.productCooldownSec * 1000) {
          const upgrade = (a.kind === 'ships_before' && c.kind !== 'ships_before')
            || (price !== null && c.price !== null && price < c.price);
          if (!upgrade) { res.skipped.push({ key: a.key, target: t, reason: 'Cooldown' }); continue; }
        }
        ctx.state.seen[t][h] = now + cfg.sentTtlSec * 1000;
        ctx.state.cool[t][ph] = { at: now, kind: a.kind, price };
        const wait = delayed(t) && configured('instant');
        ctx.state.outbox.push({
          id: `${t}:${h}`, t, kind: 'alert', k: a.key, a, c: now,
          due: delayed(t) ? now + delayMs() : now, w: wait, ia: null, n: 0, nx: 0, m: 'auto',
        });
        queuedAny = true;
      }
      if (queuedAny || targets.length === 0) {
        if (!ctx.state.log.some((e) => e.id === h)) {
          ctx.state.log.push({
            id: h, at: detected, kind: a.kind, pk: a.productKey || a.url, r: a.retailer, ti: a.title, u: a.url, p: price,
            d: a.deliveryEstimate || null, sb: a.kind === 'ships_before' ? (a.shipsBy || '') : null,
          });
        }
        res.accepted.push(a.key);
      }
      ctx.dirty = true;
    }
    return res;
  }

  // ---------- daily report ----------
  function buildReportItems(entries, t) {
    const restocks = new Map(); // per retailer + product: latest stock news
    const prices = new Map(); // per product: lowest price seen today across shops
    for (const e of entries) {
      const retailer = resolveRetailer({ retailer: e.r, url: e.u }, cfg);
      const link = checkedLink(buildLink(e.u, retailer, cfg, { privateChannel: isPrivate(t) }), { url: e.u }, retailer, `report:${e.id}`);
      if (!link) continue;
      const facts = priceFacts({ url: e.u, price: e.p }, retailer, cfg, e.at);
      const row = {
        title: e.ti, retailer: retailer.name, link, at: e.at, price: facts.pricesHidden ? null : facts.price,
        delivery: e.d, ships: e.sb !== null && e.sb !== undefined ? (cfg.shipsByLabels?.[e.sb] ?? (e.sb ? null : cfg.defaultShipsByLabel)) : null,
      };
      if (e.kind === 'restock' || e.kind === 'ships_before') {
        const k = `${e.r}|${e.pk}`;
        const prev = restocks.get(k);
        if (!prev || prev.at <= e.at) restocks.set(k, row);
      }
      if (row.price !== null) {
        const prev = prices.get(e.pk);
        if (!prev || row.price < prev.price) prices.set(e.pk, row);
      }
    }
    return {
      restocks: [...restocks.values()].sort((a, b) => b.at - a.at),
      prices: [...prices.values()].sort((a, b) => a.price - b.price),
    };
  }

  function enqueueReport(ctx, now, { force = false } = {}) {
    const rc = cfg.dailyReport || {};
    const date = berlinDate(now);
    if (!force) {
      if (!rc.enabled || ctx.state.reportSent === date || berlinHour(now) < rc.hour) return 0;
    }
    const since = ctx.state.reportAt && now - ctx.state.reportAt < 2 * DAY ? ctx.state.reportAt : now - DAY;
    if (!force) {
      ctx.state.reportSent = date;
      ctx.state.reportAt = now;
      ctx.dirty = true;
    }
    const wanted = new Set(rc.channels || ['free', 'instant']);
    if (discord) wanted.add('discord');
    let n = 0;
    for (const t of activeTargets().filter((x) => wanted.has(x))) {
      const cutoff = delayed(t) ? now - delayMs() : now;
      const entries = ctx.state.log.filter((e) => e.at > since && e.at <= cutoff);
      const items = buildReportItems(entries, t);
      if (!items.restocks.length && !items.prices.length && rc.skipEmpty !== false) continue;
      const p = renderDailyReport(items, { cfg, paid: paid(), tier: tierOf(t), now, maxItems: rc.maxItems || 10 });
      const id = `${t}:report:${date}${force ? `:${now}` : ''}`;
      if (ctx.state.outbox.some((j) => j.id === id)) continue;
      ctx.state.outbox.push({ id, t, kind: 'report', k: id, p, c: now, due: now, w: false, ia: null, n: 0, nx: 0, m: 'auto' });
      n++;
    }
    return n;
  }

  // ---------- ready-made posts (weekly market report) ----------
  // posts: [{ id, post: { html, discord, buttons, previewUrl, photo, affiliate }, channels?, expiresAt? }]. The caller renders
  // and checks the text; the engine only queues it like a report. Each id goes to each target at most once (state.once), so a
  // retry or a second caller with the same id can never post it twice. A post still queued after expiresAt (ms) is dropped.
  function enqueuePosts(ctx, now, posts) {
    let n = 0;
    ctx.state.once ??= {};
    for (const p of posts || []) {
      if (!p || !p.id || typeof p.post?.html !== 'string' || !p.post.html.trim()) continue;
      const wanted = new Set(p.channels || ['free', 'instant']);
      if (discord && p.post.discord && !p.channels) wanted.add('discord');
      for (const t of activeTargets().filter((x) => wanted.has(x))) {
        const id = `${t}:${p.id}`;
        if (ctx.state.once[id] || ctx.state.outbox.some((j) => j.id === id)) continue;
        ctx.state.once[id] = now;
        ctx.state.outbox.push({ id, t, kind: 'report', k: id, p: { buttons: null, previewUrl: null, photo: null, ...p.post }, c: now, due: now, w: false, ia: null, n: 0, nx: 0, m: 'auto', ...(Number.isFinite(p.expiresAt) ? { x: p.expiresAt } : {}) });
        ctx.dirty = true;
        n++;
      }
    }
    return n;
  }

  // ---------- rate limiting ----------
  function rateWait(ctx, t, now) {
    const r = (ctx.state.rate[t] ??= { ts: [], pause: 0 });
    r.ts = r.ts.filter((x) => now - x < MIN);
    let wait = Math.max(0, (r.pause || 0) - now);
    if (r.ts.length >= cfg.perChannelPerMinute) wait = Math.max(wait, r.ts[r.ts.length - cfg.perChannelPerMinute] + MIN - now);
    const last = r.ts[r.ts.length - 1];
    if (last) wait = Math.max(wait, last + cfg.minIntervalMs - now);
    return wait;
  }
  const markSent = (ctx, t, now) => { (ctx.state.rate[t] ??= { ts: [], pause: 0 }).ts.push(now); };

  // ---------- job lifecycle ----------
  function releaseWaiters(ctx, job, sentAt) {
    if (job.t !== 'instant' || job.kind !== 'alert') return;
    for (const j of ctx.state.outbox) {
      if (j.k === job.k && j.w) {
        j.w = false;
        if (sentAt) { j.ia = sentAt; j.due = Math.max(j.due, sentAt + delayMs()); }
      }
    }
  }

  function removeJob(ctx, job) {
    const i = ctx.state.outbox.indexOf(job);
    if (i >= 0) ctx.state.outbox.splice(i, 1);
    ctx.done.add(job.id);
    ctx.dirty = true;
  }

  function dropJob(ctx, job, now, why) {
    removeJob(ctx, job);
    releaseWaiters(ctx, job, null);
    recordError(ctx, now, `${job.t}:${truncate(job.k, 60)}`, `verworfen: ${why}`);
  }

  function eligibleAt(ctx, j, now) {
    if (j.inf) return Infinity;
    if (j.w) {
      const blocker = ctx.state.outbox.some((x) => x.t === 'instant' && x.k === j.k && x.kind === 'alert');
      if (blocker) return Infinity;
      j.w = false;
    }
    return Math.max(j.due, j.nx || 0, now + rateWait(ctx, j.t, now));
  }

  function render(job, now) {
    if (job.kind === 'report') return job.p;
    let a = job.a;
    const retailer = resolveRetailer(a, cfg);
    const link = checkedLink(buildLink(a.url, retailer, cfg, { privateChannel: isPrivate(job.t) }), a, retailer, job.k);
    if (!link) throw new SendError('link: no clean link for this post', { status: 0, retryable: false, description: 'link' });
    if (link.checked === 'fallback') a = { ...a, url: link.url }; // the preview must not use the failed tracked link either
    const facts = priceFacts(a, retailer, cfg, now);
    const tier = tierOf(job.t);
    return renderAlertPost(a, {
      cfg, paid: paid(), tier, retailer, link, facts,
      detectedAt: toMs(a.detectedAt, job.c), instantAt: job.ia, now,
    });
  }

  async function deliver(ctx, job, now) {
    const post = render(job, now);
    if (job.t === 'discord') return discord.send(post.discord);
    const chatId = ctx.state.chatMap[job.t] || cfg.channels[job.t].chatId;
    const reply_markup = post.buttons ? { inline_keyboard: post.buttons } : undefined;
    if (job.m === 'auto' && post.photo && visibleLength(post.html) <= 1024) {
      job.tried = 'photo';
      return tg.sendPhoto({ chat_id: chatId, photo: post.photo, caption: post.html, parse_mode: 'HTML', reply_markup });
    }
    job.tried = job.m === 'plain' ? 'plain' : 'text';
    const link_preview_options = cfg.linkPreview && post.previewUrl
      ? { url: post.previewUrl, prefer_large_media: true }
      : { is_disabled: true };
    if (job.m === 'plain') return tg.sendMessage({ chat_id: chatId, text: plainFromHtml(post.html), link_preview_options, reply_markup });
    return tg.sendMessage({ chat_id: chatId, text: post.html, parse_mode: 'HTML', link_preview_options, reply_markup });
  }

  function backoffMs(n) {
    const base = Math.min(5 * MIN, 2000 * 2 ** Math.max(0, n - 1));
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  async function sendLoop(ctx, t0, res) {
    const budgetEnd = t0 + cfg.runBudgetMs;
    let attempts = 0;
    for (;;) {
      const now = clock.now();
      if (attempts >= cfg.maxPostsPerRun || now >= budgetEnd) break;

      // Drop configuration orphans and stale alert jobs.
      for (const j of [...ctx.state.outbox]) {
        if (!configured(j.t)) { dropJob(ctx, j, now, 'Kanal nicht konfiguriert'); continue; }
        if (j.kind === 'alert') {
          const age = now - toMs(j.a.detectedAt, j.c);
          const limit = (cfg.staleAfterSec * 1000) + (delayed(j.t) ? delayMs() : 0);
          if (age > limit && !j.inf) dropJob(ctx, j, now, 'veraltet');
        } else if (j.x && now > j.x && !j.inf) {
          dropJob(ctx, j, now, 'veraltet'); // a ready-made post with an expiry (the weekly report after its slot)
        }
      }

      let best = null;
      let bestAt = Infinity;
      for (const j of ctx.state.outbox) {
        const at = eligibleAt(ctx, j, now);
        if (at < bestAt || (at === bestAt && best && PRIORITY[j.t] < PRIORITY[best.t])) { best = j; bestAt = at; }
      }
      if (!best) break;
      if (bestAt > now) {
        const wait = bestAt - now;
        if (wait > cfg.waitHorizonMs || bestAt > budgetEnd) break;
        await clock.sleep(wait);
        continue;
      }

      // Two-phase: persist "in flight" (and lease) before the network call.
      best.inf = now;
      ctx.state.lease = { owner: me, until: now + cfg.runBudgetMs + 15000 };
      ctx.holdsLease = true;
      await persist(ctx);

      attempts++;
      const sentAt = clock.now();
      try {
        const delivered = await deliver(ctx, best, sentAt);
        delete best.inf;
        removeJob(ctx, best);
        markSent(ctx, best.t, sentAt);
        bumpCount(ctx, sentAt, best.t);
        releaseWaiters(ctx, best, sentAt);
        ctx.state.lastPost = { at: sentAt, t: best.t };
        res.sent.push({ target: best.t, key: best.k, at: sentAt, messageId: delivered?.message_id ?? null });
      } catch (err) {
        delete best.inf;
        best.n = (best.n || 0) + 1;
        const e = err instanceof SendError ? err : new SendError(String(err?.message || err), { retryable: false });
        const label = `${best.t}:${truncate(best.k, 60)}`;
        if (e.migrateTo) {
          ctx.state.chatMap[best.t] = e.migrateTo;
          best.nx = 0;
          recordError(ctx, sentAt, label, `Chat migriert nach ${e.migrateTo}`);
        } else if (e.status === 429) {
          const ms = e.retryAfter * 1000;
          (ctx.state.rate[best.t] ??= { ts: [], pause: 0 }).pause = sentAt + ms;
          best.nx = sentAt + ms;
          recordError(ctx, sentAt, label, `429, warte ${e.retryAfter} s`);
          res.failed.push({ target: best.t, key: best.k, error: e.message, retry: true, status: e.status, retryAfter: e.retryAfter });
        } else if (e.status === 400 && best.tried === 'photo') {
          best.m = 'text';
          best.nx = 0;
          recordError(ctx, sentAt, label, `Foto abgelehnt, sende als Text: ${e.description || e.message}`);
        } else if (e.status === 400 && best.tried === 'text' && /parse|entit/i.test(e.description || e.message)) {
          best.m = 'plain';
          best.nx = 0;
          recordError(ctx, sentAt, label, `HTML abgelehnt, sende als Klartext: ${e.description || e.message}`);
        } else if (e.unknownOutcome && !cfg.retryUnknownOutcome) {
          dropJob(ctx, best, sentAt, `Zeitüberschreitung, Zustellung unklar, nicht erneut gesendet (${e.message})`);
          res.failed.push({ target: best.t, key: best.k, error: e.message, retry: false, status: e.status, unknownOutcome: true });
        } else if (e.retryable && best.n < cfg.maxAttempts) {
          best.nx = sentAt + backoffMs(best.n);
          recordError(ctx, sentAt, label, `Versuch ${best.n} fehlgeschlagen: ${e.message}`);
          res.failed.push({ target: best.t, key: best.k, error: e.message, retry: true, status: e.status });
        } else {
          dropJob(ctx, best, sentAt, e.message);
          res.failed.push({ target: best.t, key: best.k, error: e.message, retry: false, status: e.status });
        }
        ctx.dirty = true;
      }
    }
  }

  // ---------- public API ----------
  async function run({ alerts = [], forceReport = false, posts = [] } = {}) {
    return serial(async () => {
      const t0 = clock.now();
      const ctx = await load();
      linkEvents = [];
      const res = { accepted: [], skipped: [], sent: [], failed: [], reports: 0, posts: 0, queued: 0, nextDueAt: null, mode: paid() ? 'paid' : 'launch', links: linkEvents };
      try {
        prune(ctx, t0);
        const ing = ingest(ctx, alerts, t0);
        res.accepted = ing.accepted;
        res.skipped = ing.skipped;
        res.reports = enqueueReport(ctx, t0, { force: forceReport });
        res.posts = enqueuePosts(ctx, t0, posts);
        const lease = ctx.state.lease;
        const othersLease = lease && lease.owner !== me && lease.until > t0;
        if (!othersLease && ctx.state.outbox.length) await sendLoop(ctx, t0, res);
        if (!othersLease) {
          if (ctx.holdsLease || (lease && lease.owner === me)) { ctx.state.lease = null; ctx.dirty = true; }
        }
        const now = clock.now();
        if (now - (ctx.state.hb || 0) >= cfg.heartbeatEveryMs) { ctx.state.hb = now; ctx.dirty = true; }
      } finally {
        if (ctx.dirty) await persist(ctx);
      }
      res.queued = ctx.state.outbox.length;
      const due = ctx.state.outbox.map((j) => Math.max(j.due, j.nx || 0)).sort((a, b) => a - b)[0];
      res.nextDueAt = due ?? null;
      return res;
    });
  }

  async function monitorHealthLines() {
    if (!monitorStore) return [];
    try {
      const h = await monitorStore.get('health');
      const rs = Object.entries(h?.retailers || {});
      if (!rs.length) return [];
      const bad = rs.filter(([, r]) => r.status && r.status !== 'ok');
      const ok = rs.length - bad.length;
      const out = [`Shops: ${ok}/${rs.length} ok${h.updatedAt ? ` (Stand ${berlinTime(toMs(h.updatedAt, clock.now()))})` : ''}`];
      for (const [id, r] of bad.slice(0, 8)) out.push(`⚠️ ${escapeHtml(id)}: ${escapeHtml(r.status)}${r.lastError ? `, ${escapeHtml(truncate(r.lastError, 60))}` : ''}`);
      return out;
    } catch (e) {
      return [`Shops: Status nicht lesbar (${escapeHtml(truncate(e.message, 60))})`];
    }
  }

  async function statusText() {
    const { state } = await load();
    const now = clock.now();
    const lines = [`📡 <b>${escapeHtml(cfg.brand)} Status</b> · ${berlinTime(now)}`];
    lines.push(paid()
      ? `Modus: <b>Privat + öffentlich</b> (öffentlich ${delayText(cfg.freeDelaySec)} später)`
      : `Modus: <b>Sofort</b> (jeder Fund geht direkt raus)${cfg.paidTier ? ', PAID_TIER an, aber INSTANT_CHAT_ID fehlt' : ''}`);
    const ch = (t) => (configured(t) ? '✅' : 'aus');
    lines.push(`Kanal: ${ch('free')} · Privat: ${ch('instant')} · Discord: ${ch('discord')}`);
    const next = state.outbox.map((j) => Math.max(j.due, j.nx || 0)).sort((a, b) => a - b)[0];
    lines.push(`Warteschlange: ${state.outbox.length}${next ? ` · nächster Post ${berlinTime(Math.max(next, now))}` : ''}`);
    const by = state.counts.date === berlinDate(now) ? state.counts.by : {};
    lines.push(`Heute gepostet: Kanal ${by.free || 0} · Privat ${by.instant || 0} · Discord ${by.discord || 0}`);
    lines.push(`Letzter Post: ${state.lastPost ? `${berlinDate(state.lastPost.at) === berlinDate(now) ? '' : berlinDate(state.lastPost.at) + ' '}${berlinTime(state.lastPost.at)}` : 'noch keiner'}`);
    if (state.hb) lines.push(`Lebenszeichen: ${berlinTime(state.hb)}${now - state.hb > 2 * cfg.heartbeatEveryMs ? ' ⚠️ zu alt' : ''}`);
    lines.push(`Tagesbericht: ${cfg.dailyReport?.enabled ? `${cfg.dailyReport.hour}:00 Uhr${state.reportSent === berlinDate(now) ? ', heute erledigt' : ''}` : 'aus'}`);
    lines.push(...(await monitorHealthLines()));
    const errs = state.errors.filter((e) => now - e.at < DAY);
    if (errs.length) {
      const last = errs[errs.length - 1];
      lines.push(`Meldungen (24 h): ${errs.length} · zuletzt ${berlinTime(last.at)}: ${escapeHtml(truncate(last.msg, 120))}`);
    } else lines.push('Meldungen (24 h): keine');
    for (const w of configWarnings(cfg)) lines.push(`⚠️ ${escapeHtml(w)}`);
    return lines.join('\n');
  }

  async function reply(chatId, html, extra = {}) {
    return tg.sendMessage({ chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  }

  // Sample posts, rendered exactly like the channel would see them, sent only to the admin's own chat.
  function samplePosts(now) {
    const iso = new Date(now - 2000).toISOString();
    const base = { productKey: 'ps5-pro', retailer: 'amazon', title: 'PlayStation 5 Pro (Beispiel)', url: 'https://www.amazon.de/dp/B0DHSV68YZ', price: 899.99, listPrice: 899.99, listPriceType: 'uvp', detectedAt: iso, inStock: true };
    return [
      { ...base, key: 'sample:1', kind: 'restock', retailer: 'mediamarkt', url: 'https://www.mediamarkt.de/de/product/_sony-playstation-5-pro-3018022.html', deliveryEstimate: '2026-10-08', deliveryAssumed: true },
      { ...base, key: 'sample:2', kind: 'ships_before', retailer: 'cyberport', title: 'Grand Theft Auto VI (PS5) (Beispiel)', url: 'https://www.cyberport.de/beispiel', price: 79.99, listPrice: null, isPreorder: true, deliveryEstimate: '2026-11-12', shipsBy: '2026-11-18' },
      { ...base, key: 'sample:3', kind: 'restock', isBackorder: true, deliveryEstimate: '2027-03-02' },
    ];
  }

  // Checks the bot's rights in each channel, sets the channel description and posts + pins the info post once.
  async function setupChannels({ pin = true } = {}) {
    const lines = [];
    const bot = await tg.getMe();
    lines.push(`Bot: @${bot.username}`);
    for (const t of ['free', 'instant']) {
      if (!configured(t)) continue;
      const label = t === 'free' ? 'Kanal' : 'Privater Kanal';
      const chatId = cfg.channels[t].chatId;
      try {
        const chat = await tg.call('getChat', { chat_id: chatId });
        const member = await tg.call('getChatMember', { chat_id: chatId, user_id: bot.id });
        const admin = member.status === 'administrator' || member.status === 'creator';
        lines.push(`${label}: ${escapeHtml(chat.title || chatId)} (ID <code>${chat.id}</code>)`);
        if (!admin || member.can_post_messages === false) {
          lines.push('⚠️ Bot ist dort kein Admin mit "Nachrichten senden". Bitte als Admin hinzufügen.');
          continue;
        }
        const desc = channelDescription(cfg);
        if ((chat.description || '') === desc) lines.push('Beschreibung: passt');
        else if (member.can_change_info === false) lines.push('⚠️ Beschreibung nicht gesetzt: Bot braucht das Recht "Kanalinfo ändern" (oder /texte und von Hand einfügen).');
        else {
          await tg.call('setChatDescription', { chat_id: chatId, description: desc });
          lines.push('Beschreibung: gesetzt');
        }
        if (pin && t === 'free') {
          // "Done" is per chat: the same bot pins in the private test channel first and in the public one after promotion.
          // A state from before this field existed has no chat recorded and counts as not done (one more pin in a test channel is harmless).
          const st = (await load()).state;
          const done = st.pinned?.[t] && String(st.pinnedChat?.[t] ?? '') === String(chatId);
          if (done) lines.push('Info-Post: schon angepinnt');
          else {
            const m = await tg.sendMessage({ chat_id: chatId, text: pinnedPost(cfg), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
            try {
              await tg.call('pinChatMessage', { chat_id: chatId, message_id: m.message_id, disable_notification: true });
              lines.push('Info-Post: gepostet und angepinnt');
            } catch (e) {
              lines.push(`Info-Post: gepostet, Anpinnen ging nicht (${escapeHtml(truncate(e.message, 60))}). Bitte von Hand anpinnen.`);
            }
            await serial(async () => {
              const ctx = await load();
              ctx.state.pinned = { ...(ctx.state.pinned || {}), [t]: m.message_id };
              ctx.state.pinnedChat = { ...(ctx.state.pinnedChat || {}), [t]: String(chatId) };
              await persist(ctx);
            });
          }
        }
      } catch (e) {
        lines.push(`⚠️ ${label} ${escapeHtml(chatId)}: ${escapeHtml(truncate(e.message, 120))}`);
      }
    }
    return lines;
  }

  // Telegram update (webhook body or one getUpdates item).
  async function handleUpdate(update) {
    const msg = update?.message || update?.edited_message;
    const text = msg?.text?.trim();
    if (!text || !text.startsWith('/')) return { handled: false };
    const m = /^\/(status|start|help|testpost|report|setup|texte)(@[\w_]+)?(\s|$)/i.exec(text);
    if (!m) return { handled: false };
    const cmd = m[1].toLowerCase();
    const from = String(msg.from?.id ?? '');
    const admins = (cfg.adminIds || []).map(String);
    const isAdmin = admins.includes(from);
    if (!isAdmin) {
      // Everyone else: public info with Impressum (required for a commercial channel). Private chats only.
      if (cmd !== 'start' && cmd !== 'help' && admins.length) return { handled: false, ignored: 'not-admin' };
      if (msg.chat?.type && msg.chat.type !== 'private') return { handled: false, ignored: 'not-private' };
      const idLine = admins.length ? '' : `\n\nDeine Telegram-ID: <code>${escapeHtml(from)}</code> (als ADMIN_IDS eintragen, dann geht /status)`;
      await reply(msg.chat.id, startText(cfg) + idLine);
      return { handled: true, cmd, admin: false };
    }
    if (cmd === 'status' || cmd === 'start' || cmd === 'help') {
      let body = await statusText();
      if (cmd !== 'status') body += '\n\nBefehle: /status · /testpost (Beispiele nur an dich) · /report (Tagesbericht jetzt) · /setup (Kanal prüfen) · /texte';
      await reply(msg.chat.id, body);
      return { handled: true, cmd, admin: true };
    }
    if (cmd === 'testpost') {
      const now = clock.now();
      for (const a of samplePosts(now)) {
        const post = render({ t: 'free', kind: 'alert', a, c: now, ia: null }, now);
        await reply(msg.chat.id, post.html, { reply_markup: { inline_keyboard: post.buttons } });
      }
      return { handled: true, cmd, admin: true };
    }
    if (cmd === 'setup') {
      await reply(msg.chat.id, (await setupChannels()).join('\n'));
      return { handled: true, cmd, admin: true };
    }
    if (cmd === 'texte') {
      const d = channelDescription(cfg);
      await reply(msg.chat.id, `<b>Kanalbeschreibung</b> (${d.length}/255):\n<code>${escapeHtml(d)}</code>`);
      await reply(msg.chat.id, pinnedPost(cfg));
      return { handled: true, cmd, admin: true };
    }
    if (cmd === 'report') {
      const r = await run({ forceReport: true });
      await reply(msg.chat.id, `Tagesbericht: ${r.sent.filter((x) => String(x.key).includes(':report:')).length} gesendet${r.reports ? '' : ' (keine Funde seit dem letzten Bericht)'}.`);
      return { handled: true, cmd, admin: true };
    }
    return { handled: false };
  }

  // Long-polling for Node (Workers use the webhook route instead). Returns number of updates handled.
  async function pollCommands({ timeoutSec = 25 } = {}) {
    const { state } = await load();
    const updates = await tg.getUpdates({ offset: (state.updOffset || 0) + 1 || undefined, timeout: timeoutSec, allowed_updates: ['message'] });
    if (!updates?.length) return 0;
    const maxId = Math.max(...updates.map((u) => u.update_id));
    await serial(async () => {
      const ctx = await load();
      ctx.state.updOffset = Math.max(ctx.state.updOffset || 0, maxId);
      await persist(ctx);
    });
    for (const u of updates) {
      try { await handleUpdate(u); } catch (e) { log?.warn?.(`[drop-radar] command failed: ${e.message}`); }
    }
    return updates.length;
  }

  async function snapshot() { return (await load()).state; }

  return { run, handleUpdate, pollCommands, setupChannels, statusText, snapshot, config: cfg, telegram: tg };
}
