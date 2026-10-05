// Nothing secret may reach the public state branch. The state is built from monitor and bot data that holds no keys,
// but error texts can carry a URL, so every file is scrubbed against the secrets of this run before it is pushed.
import { feedsFromEnv } from '../../monitor/src/feeds/index.js';

const SECRET_NAMES = /^(TELEGRAM_BOT_TOKEN|AWIN_API_TOKEN|DISCORD_WEBHOOK_URL|ALERT_WEBHOOK_SECRET|PROXY_URL|PROXY_API_TEMPLATE|PROXY_API_HEADERS|UPSTASH_REDIS_REST_TOKEN|GH_TOKEN|GITHUB_TOKEN|FEED_URL_[A-Z0-9_]+)$/;
// Shapes that are secrets whoever owns them.
const SHAPES = [
  /\b\d{8,11}:[A-Za-z0-9_-]{34,36}\b/g, // Telegram bot token
  /(apikey\/)[A-Za-z0-9]{12,}/gi, // Awin classic feed key in a URL
  /([?&;]token=)[A-Za-z0-9._-]{12,}/gi, // Tradedoubler token in a URL
  /(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
];

/** Literal secret values from the environment, plus keys inside configured feed URLs. */
export function collectSecrets(env = {}) {
  const out = new Set();
  const add = (v) => {
    const s = String(v ?? '').trim();
    if (s.length >= 6) out.add(s);
  };
  for (const [k, v] of Object.entries(env)) if (SECRET_NAMES.test(k)) add(v);
  for (const id of String(env.ADMIN_IDS ?? '').split(/[,\s]+/)) add(id.length >= 6 ? id : '');
  for (const feed of Object.values(feedsFromEnv(env))) for (const s of feed.secrets ?? []) add(s);
  // longest first, so a URL is replaced before the key inside it
  return [...out].sort((a, b) => b.length - a.length);
}

/** Replace every secret in `text`. Returns the clean text and how many places were changed. */
export function scrub(text, secrets = []) {
  let out = String(text);
  let count = 0;
  for (const s of secrets) {
    const parts = out.split(s);
    if (parts.length > 1) {
      count += parts.length - 1;
      out = parts.join('***');
    }
  }
  for (const re of SHAPES) {
    out = out.replace(re, (m, g1) => {
      count++;
      return g1 ? `${g1}***` : '***';
    });
  }
  return { text: out, count };
}
