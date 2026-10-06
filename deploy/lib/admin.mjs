// Alerts to the owner's private admin chat (secret TELEGRAM_ADMIN_CHAT_ID), never to the public channel.
//
// Never spam: every alert has a key. The same key is not sent again inside the cooldown, at most maxPerRun messages go
// out per run (the rest are folded into one summary line), a 429 stops sending until Telegram's retry_after has passed,
// and anything that could not be sent waits in a small outbox for the next run (capped, expires after a day).
// Plain text only: no parse mode, so a stray "<" in an error message can never make the alert itself fail.
const MIN = 60000;
const SEV = { critical: 0, warn: 1, info: 2 };

export function emptyAdminState() {
  return { sent: {}, outbox: [], pauseUntil: 0, lastError: null, lastOkAt: null };
}

export function loadAdminState(v) {
  const e = emptyAdminState();
  return v && typeof v === 'object' ? { ...e, ...v, sent: { ...(v.sent ?? {}) }, outbox: [...(v.outbox ?? [])] } : e;
}

/**
 * @param {object} o
 * @param {string} [o.token]   bot token
 * @param {string} [o.chatId]  admin chat
 * @param {object} o.state     loadAdminState(...) result, mutated in place; the caller saves it
 * @param {object} o.cfg       ops config (admin section used)
 */
export function createAdmin({ token, chatId, apiBase = 'https://api.telegram.org', fetch: fetchImpl = globalThis.fetch?.bind(globalThis), now = () => Date.now(), state, cfg, label = 'Lagerfunk', timeoutMs = 15000 }) {
  const c = cfg.admin;
  const st = state ?? emptyAdminState();
  const configured = Boolean(token && chatId);

  /** Queue an alert. Returns false when the same key was sent inside the cooldown. */
  function raise(key, text, { severity = 'warn', cooldownMinutes = c.cooldownMinutes } = {}) {
    const t = now();
    const last = st.sent[key];
    if (last && t - last < cooldownMinutes * MIN) return false;
    const msg = { key, text: String(text).slice(0, 3500), sev: severity, at: t };
    const i = st.outbox.findIndex((m) => m.key === key);
    if (i >= 0) st.outbox[i] = msg;
    else st.outbox.push(msg);
    return true;
  }

  async function send(text) {
    let res;
    try {
      res = await fetchImpl(`${apiBase.replace(/\/$/, '')}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { ok: false, status: 0, error: `network: ${e?.message ?? e}` };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (res.ok && data?.ok) return { ok: true };
    return { ok: false, status: data?.error_code ?? res.status, error: data?.description ?? `http ${res.status}`, retryAfter: Number(data?.parameters?.retry_after) || 0 };
  }

  /**
   * Send what is queued. Returns { configured, sent, failed, pending, error }.
   */
  async function flush() {
    const t = now();
    st.outbox = st.outbox.filter((m) => t - m.at <= c.outboxTtlHours * 3600000).sort((a, b) => (SEV[a.sev] ?? 1) - (SEV[b.sev] ?? 1) || a.at - b.at).slice(0, c.outboxMax);
    for (const [k, at] of Object.entries(st.sent)) if (t - at > 7 * 86400000) delete st.sent[k];
    const out = { configured, sent: 0, failed: 0, pending: st.outbox.length, error: null, keys: [] };
    if (!configured || !st.outbox.length) return out;
    if (st.pauseUntil > t) {
      out.error = `paused until ${new Date(st.pauseUntil).toISOString()} (429)`;
      return out;
    }
    const batch = st.outbox.slice(0, c.maxPerRun);
    const rest = st.outbox.slice(c.maxPerRun);
    const messages = batch.map((m) => ({ keys: [m.key], text: `${label}: ${m.text}` }));
    if (rest.length) {
      messages[messages.length - 1] = {
        keys: [batch.at(-1).key, ...rest.map((m) => m.key)],
        text: `${messages.at(-1).text}\n\n${label}: ${rest.length} more alert(s) folded in: ${rest.map((m) => m.text.split('\n')[0].slice(0, 120)).join(' | ')}`,
      };
    }
    for (const m of messages) {
      const r = await send(m.text);
      if (!r.ok) {
        out.failed += 1;
        out.error = `${r.status} ${r.error}`;
        st.lastError = out.error;
        if (r.status === 429) st.pauseUntil = t + Math.max(1, r.retryAfter) * 1000;
        break; // stop at the first failure: never hammer a failing API
      }
      out.sent += 1;
      out.keys.push(...m.keys);
      for (const k of m.keys) st.sent[k] = t;
      st.outbox = st.outbox.filter((x) => !m.keys.includes(x.key));
      st.lastOkAt = new Date(t).toISOString();
    }
    out.pending = st.outbox.length;
    return out;
  }

  return { raise, flush, state: st, configured };
}
