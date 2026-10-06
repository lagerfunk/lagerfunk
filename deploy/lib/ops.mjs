// Operations an AI session (or the owner) runs by hand: rollback, tag a good version, restore, back up, retract a
// false post, notify, promote or demote staging, print the status. Entry point: deploy/ops.mjs. Every function takes
// its git runner, fetch and clock as arguments so the tests drive them against real local repositories.
import { fetchState } from './gitstate.mjs';
import { parseState } from './store.mjs';
import { parseActivity } from './activity.mjs';
import { promotionGate, setChannel } from './stage.mjs';
import { LEDGER_KEY, HELD_KEY, BREAKERS_KEY } from './breakers.mjs';

export const GOOD_TAG = 'last-known-good';
export const GOOD_PREFIX = 'lkg-';
export const KEEP_GOOD_TAGS = 10;

const stamp = (ms) => `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`; // 20261006T080412Z

/** Remote tags: [{ tag, sha }] for the given pattern. */
export async function remoteTags(git, pattern) {
  const text = await git(['ls-remote', '--tags', 'origin', pattern]);
  return text.split('\n').filter(Boolean).map((l) => {
    const [sha, ref] = l.split('\t');
    return { tag: ref.replace(/^refs\/tags\//, ''), sha };
  }).filter((t) => !t.tag.endsWith('^{}'));
}

/**
 * After a passing smoke test: point last-known-good at `sha`, add a dated lkg- tag, keep the newest KEEP_GOOD_TAGS.
 */
export async function tagGood({ git, sha, now = Date.now(), keep = KEEP_GOOD_TAGS }) {
  if (!/^[0-9a-f]{7,40}$/.test(sha ?? '')) throw new Error(`tag-good needs a commit sha, got "${sha}"`);
  const full = (await git(['rev-parse', `${sha}^{commit}`])).trim();
  const name = `${GOOD_PREFIX}${stamp(now)}-${full.slice(0, 7)}`;
  await git(['tag', '-f', GOOD_TAG, full]);
  await git(['tag', '-f', name, full]);
  await git(['push', '--quiet', '--force', 'origin', `refs/tags/${GOOD_TAG}`, `refs/tags/${name}`]);
  const all = (await remoteTags(git, `refs/tags/${GOOD_PREFIX}*`)).sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const old = all.slice(0, Math.max(0, all.length - keep));
  for (const t of old) await git(['push', '--quiet', 'origin', '--delete', `refs/tags/${t.tag}`]);
  return { tag: name, sha: full, pruned: old.map((t) => t.tag) };
}

/**
 * Move last-known-good back. Without `to`: to the newest lkg- tag older than the current one.
 * The scheduled runner checks out last-known-good, so the next run (within 10 minutes) uses the old code.
 */
export async function rollback({ git, to = null }) {
  const cur = (await remoteTags(git, `refs/tags/${GOOD_TAG}`))[0] ?? null;
  const all = (await remoteTags(git, `refs/tags/${GOOD_PREFIX}*`)).sort((a, b) => (a.tag < b.tag ? -1 : 1));
  let target;
  if (to) {
    target = all.find((t) => t.tag === to || t.sha.startsWith(to));
    if (!target) throw new Error(`no tag or good commit "${to}". Known: ${all.map((t) => t.tag).join(', ') || 'none'}`);
  } else {
    const curIdx = cur ? all.map((t) => t.sha).lastIndexOf(cur.sha) : all.length;
    target = [...all.slice(0, curIdx < 0 ? all.length : curIdx)].reverse().find((t) => t.sha !== cur?.sha);
    if (!target) throw new Error(`nothing older to roll back to (current ${cur?.sha?.slice(0, 7) ?? 'none'}, ${all.length} good tags)`);
  }
  await git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/tags/${target.tag}:refs/tags/${target.tag}`]);
  await git(['push', '--quiet', '--force', 'origin', `${target.sha}:refs/tags/${GOOD_TAG}`]);
  return { from: cur?.sha ?? null, to: target.sha, tag: target.tag };
}

/** Read what the runner wrote: heartbeat, breakers, held posts and the post ledger. */
export async function readRunnerState({ git }) {
  const st = await fetchState({ git });
  if (st.status !== 'ok') return { status: 'missing' };
  const parsed = parseState(st.files['state.json']);
  let status = null;
  try {
    status = JSON.parse(st.files['status.json'] ?? 'null');
  } catch {
    status = null;
  }
  return {
    status: 'ok',
    sha: st.sha,
    statusJson: status,
    lines: parseActivity(st.files['activity.jsonl']),
    breakers: parsed.ok ? parsed.entries[BREAKERS_KEY]?.v ?? null : null,
    held: parsed.ok ? parsed.entries[HELD_KEY]?.v ?? [] : [],
    ledger: parsed.ok ? parsed.entries[LEDGER_KEY]?.v ?? {} : {},
  };
}

async function tgCall({ env, fetch: fetchImpl }, method, body) {
  const base = (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
  const res = await fetchImpl(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw Object.assign(new Error(`${data?.error_code ?? res.status} ${data?.description ?? ''}`.trim()), { status: data?.error_code ?? res.status });
  return data.result;
}

export const RETRACT_TEXT = 'Korrektur: Diese Meldung war ein Fehlalarm und wurde zurückgezogen. Bitte ignorieren.';

/**
 * Take a false post back. `key` matches the ledger key (kind|shop|product|cents) by substring; "last" = newest post.
 * Deletes the message; if Telegram refuses (older than 48 h, missing right), edits it into a correction instead.
 */
export async function retract({ git, env, fetch: fetchImpl, key = 'last', brandHandle = 'lagerfunk' }) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  const { ledger } = await readRunnerState({ git });
  const sent = Object.entries(ledger ?? {}).filter(([, e]) => e.s === 'sent' && e.m).sort((a, b) => a[1].at - b[1].at);
  const hit = key === 'last' ? sent.at(-1) : sent.filter(([k]) => k.includes(key)).at(-1);
  if (!hit) throw new Error(`no sent post matches "${key}". Sent: ${sent.map(([k]) => k).slice(-10).join(', ') || 'none'}`);
  const [idem, e] = hit;
  const chat = e.ch === 'staging' ? env.TELEGRAM_CHAT_ID_STAGING : env.FREE_CHAT_ID || `@${brandHandle}`;
  if (!chat) throw new Error(`the post went to ${e.ch}, but its chat id is not set here`);
  const ctx = { env, fetch: fetchImpl };
  try {
    await tgCall(ctx, 'deleteMessage', { chat_id: chat, message_id: e.m });
    return { idem, messageId: e.m, channel: e.ch, action: 'deleted' };
  } catch (err) {
    await tgCall(ctx, 'editMessageText', { chat_id: chat, message_id: e.m, text: RETRACT_TEXT });
    return { idem, messageId: e.m, channel: e.ch, action: 'edited', deleteError: err.message };
  }
}

/** One message to the admin chat, outside any run (smoke failures, ops results). */
export async function notify({ env, fetch: fetchImpl, text }) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ADMIN_CHAT_ID) return { ok: false, error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID not set' };
  try {
    await tgCall({ env, fetch: fetchImpl }, 'sendMessage', { chat_id: env.TELEGRAM_ADMIN_CHAT_ID, text: String(text).slice(0, 3800), link_preview_options: { is_disabled: true } });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Promotion with the gate. `exec` runs gh; injectable. */
export async function promote({ git, exec, cfg, now = Date.now(), force = false, dryRun = false, repo = null }) {
  const rs = await readRunnerState({ git });
  const gate = promotionGate({ status: rs.statusJson, lines: rs.lines ?? [], now, cfg });
  if (!gate.ok && !force) return { ok: false, promoted: false, gate };
  const r = await setChannel({ to: 'public', repo, exec, dryRun });
  return { ok: r.ok, promoted: r.ok && !dryRun, gate, command: r.command, error: r.error };
}

export async function demote({ exec, repo = null, dryRun = false }) {
  const r = await setChannel({ to: 'staging', repo, exec, dryRun });
  return { ok: r.ok, command: r.command, error: r.error };
}
