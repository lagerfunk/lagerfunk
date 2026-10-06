// Structured log: one JSON object per line on stdout, next to the short human lines the runner already prints.
// Shape: {"ts":"2026-10-06T08:04:12.345Z","lvl":"warn","ev":"breaker.trip","run":"123","breaker":"retailer",...}
// `ev` names are stable so another session can grep them: run.start, run.end, check.summary, breaker.trip,
// breaker.recover, breaker.hold, price.quarantine, dedupe.skip, post.sent, post.failed, admin.sent, state.saved, ...
//
// Never logged: secrets (scrubbed by value and by shape, see secrets.mjs) and personal data (chat ids and Telegram
// user ids, removed by value and by field name). Product data (prices, shops, URLs) is public and stays.
import { scrub } from './secrets.mjs';

const PERSONAL_FIELD = /^(token|secret|password|authorization|chat_?id|admin_?ids?|user_?id|from|email|phone)$/i;

/** Replace personal values (numeric ids) only where they stand alone, so an EAN that contains the digits survives. */
export function scrubPersonal(text, values = []) {
  let out = String(text);
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (s.length < 5) continue;
    const re = new RegExp(`(?<![0-9A-Za-z_-])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z_-])`, 'g');
    out = out.replace(re, '[personal]');
  }
  return out;
}

function clean(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clean(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = PERSONAL_FIELD.test(k) ? '[redacted]' : clean(v, depth + 1);
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}...`;
  return value;
}

/** Personal values from the environment: admin chat, staging chat, admin user ids. */
export function personalValues(env = {}) {
  return [env.TELEGRAM_ADMIN_CHAT_ID, env.TELEGRAM_CHAT_ID_STAGING, ...String(env.ADMIN_IDS ?? '').split(/[,\s]+/)].filter((v) => v && String(v).trim().length >= 5);
}

/**
 * @param {{ out?: (line: string) => void, secrets?: string[], personal?: string[], base?: object, now?: () => number }} o
 */
export function createJsonLog({ out = (l) => console.log(l), secrets = [], personal = [], base = {}, now = () => Date.now() } = {}) {
  const lines = [];
  const write = (lvl, ev, fields = {}) => {
    const rec = { ts: new Date(now()).toISOString(), lvl, ev, ...clean(base), ...clean(fields) };
    const text = scrubPersonal(scrub(JSON.stringify(rec), secrets).text, personal);
    lines.push(text);
    out(text);
    return rec;
  };
  return {
    lines,
    info: (ev, f) => write('info', ev, f),
    warn: (ev, f) => write('warn', ev, f),
    error: (ev, f) => write('error', ev, f),
  };
}

/** The JSON lines out of mixed output (human lines are skipped). */
export function parseJsonLines(lines) {
  const out = [];
  for (const l of lines) {
    if (!l.startsWith('{"ts":')) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* not one of ours */
    }
  }
  return out;
}
