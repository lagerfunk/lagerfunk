// Small, runtime-neutral helpers. No Node-only APIs: this file runs in Node 22 and Cloudflare Workers.

export const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))),
};

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Prices arrive as numbers in EUR (899.99). Strings like "899,99" or "1.299,99 €" are tolerated.
export function parsePrice(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  let s = String(v).replace(/[^\d.,]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// German format without relying on ICU locale data: 1299.9 -> "1.299,90 €" (non-breaking space).
export function formatEuro(n) {
  const fixed = (Math.round(n * 100) / 100).toFixed(2);
  const [int, dec] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${grouped},${dec} €`;
}

// detectedAt may be an ISO string, epoch ms or epoch seconds.
export function toMs(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : fallback;
}

const TZ = 'Europe/Berlin';
let fmt;
function berlinParts(ms) {
  fmt ??= new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
export const berlinTime = (ms) => { const p = berlinParts(ms); return `${p.hour}:${p.minute}:${p.second}`; };
export const berlinDate = (ms) => { const p = berlinParts(ms); return `${p.year}-${p.month}-${p.day}`; };
export const berlinDateDE = (ms) => { const p = berlinParts(ms); return `${p.day}.${p.month}.${p.year}`; };
export const berlinHour = (ms) => Number(berlinParts(ms).hour);

// FNV-1a, used to keep store keys short and safe.
export function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
// 64-bit-ish hash for dedupe keys (two independent FNV-1a passes). Keeps the state document small.
export function keyHash(s) {
  s = String(s);
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a ^= c; a = Math.imul(a, 0x01000193);
    b ^= c; b = Math.imul(b, 0x5bd1e995); b ^= b >>> 15;
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

export function safeKeyPart(s) {
  const clean = String(s).replace(/[^A-Za-z0-9._:-]/g, '_');
  return clean.length <= 120 ? clean : `${clean.slice(0, 80)}~${shortHash(String(s))}`;
}

export function decode(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function isHttpUrl(u) {
  try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:'; } catch { return false; }
}
