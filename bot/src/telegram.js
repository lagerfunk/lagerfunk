// Minimal fetch-based Telegram Bot API client. Works in Node 22 and Cloudflare Workers.

export class SendError extends Error {
  constructor(message, { status = 0, retryAfter = 0, retryable = false, unknownOutcome = false, migrateTo = null, description = '' } = {}) {
    super(message);
    this.name = 'SendError';
    this.status = status;
    this.retryAfter = retryAfter;       // seconds, from a 429
    this.retryable = retryable;         // safe to try again later
    this.unknownOutcome = unknownOutcome; // request may or may not have been delivered
    this.migrateTo = migrateTo;
    this.description = description;
  }
}

export async function httpJson(fetchImpl, url, body, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // Connection never opened: nothing was delivered, safe to retry.
    const code = e?.cause?.code || e?.code || '';
    const neverSent = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
    // Otherwise (timeout, reset mid-request) we cannot know whether it arrived. The engine decides.
    throw new SendError(`network: ${e?.name || ''} ${code} ${e?.message || e}`.replace(/\s+/g, ' ').trim(), { retryable: true, unknownOutcome: !neverSent });
  }
  let data = null;
  const text = await res.text().catch(() => '');
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { res, data, text };
}

export function createTelegram({ token, apiBase = 'https://api.telegram.org', fetch: fetchImpl, timeoutMs = 15000 }) {
  const base = `${apiBase.replace(/\/$/, '')}/bot${token}`;

  async function call(method, payload) {
    if (!token) throw new SendError('TELEGRAM_BOT_TOKEN fehlt', { status: 401 });
    const { res, data, text } = await httpJson(fetchImpl, `${base}/${method}`, payload, timeoutMs);
    if (res.ok && data?.ok) return data.result;
    const status = data?.error_code || res.status;
    const description = data?.description || text.slice(0, 200) || res.statusText;
    const params = data?.parameters || {};
    if (status === 429) {
      const ra = Number(params.retry_after ?? res.headers.get('retry-after') ?? 5);
      throw new SendError(`429 ${description}`, { status, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 5, retryable: true, description });
    }
    if (params.migrate_to_chat_id) {
      throw new SendError(`migrated: ${description}`, { status, migrateTo: String(params.migrate_to_chat_id), retryable: true, description });
    }
    if (status >= 500) throw new SendError(`${status} ${description}`, { status, retryable: true, description });
    throw new SendError(`${status} ${description}`, { status, retryable: false, description });
  }

  return {
    call,
    sendMessage: (p) => call('sendMessage', p),
    sendPhoto: (p) => call('sendPhoto', p),
    getMe: () => call('getMe', {}),
    getUpdates: (p) => call('getUpdates', p),
  };
}

// Discord webhook output. Same error contract as Telegram.
export function createDiscord({ url, fetch: fetchImpl, timeoutMs = 15000, username = 'Drop Radar' }) {
  return {
    async send(content) {
      const target = url.includes('?') ? `${url}&wait=true` : `${url}?wait=true`;
      const { res, data, text } = await httpJson(fetchImpl, target, {
        content: content.length > 2000 ? `${content.slice(0, 1990)}…` : content,
        username,
        allowed_mentions: { parse: [] },
      }, timeoutMs);
      if (res.ok) return { message_id: data?.id ?? null, date: null };
      const description = data?.message || text.slice(0, 200);
      if (res.status === 429) {
        const ra = Number(data?.retry_after ?? res.headers.get('retry-after') ?? 2);
        throw new SendError(`429 ${description}`, { status: 429, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 2, retryable: true, description });
      }
      if (res.status >= 500) throw new SendError(`${res.status} ${description}`, { status: res.status, retryable: true, description });
      throw new SendError(`${res.status} ${description}`, { status: res.status, description });
    },
  };
}

// Visible length of Telegram HTML, used for the 1024-char caption limit.
export function visibleLength(html) {
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&(lt|gt|amp|quot);/g, '_')
    .length;
}
