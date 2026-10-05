import defaultRetailers from '../config/retailers.js';

export const DEFAULTS = Object.freeze({
  brand: 'Drop Radar',
  channelUrl: 'https://t.me/dropradar_de',
  impressumUrl: 'https://dropradar.de/impressum',

  // The public Free channel is the product: every alert posts at once.
  // PAID_TIER (off) is the switch for a later private channel. On + INSTANT_CHAT_ID set: private channel gets
  // alerts at once, the public channel FREE_DELAY_SEC later with a proof line and a JOIN_URL link.
  paidTier: false,
  freeDelaySec: 180,
  joinUrl: '',
  channels: { instant: { chatId: '' }, free: { chatId: '' } },
  discordWebhookUrl: '',
  discordTier: 'free',
  adminIds: [],

  // Affiliate
  amazonTag: '',
  awinAffId: '',
  awinMids: {},

  // Compliance (PAngV / Amazon)
  amazonPriceAllowed: false,
  trustLowest30dWithoutHistory: false,

  // Copy
  showSpeedLine: true,
  linkPreview: true,
  usePhotos: false, // re-uploading shop photos risks § 72 UrhG warning letters. Link preview only.
  shipsByLabels: { '2026-11-18': 'GTA VI', '2026-11-19': 'GTA VI' },
  defaultShipsByLabel: 'GTA VI',

  // Reliability
  perChannelPerMinute: 20,
  minIntervalMs: 1100,
  maxPostsPerRun: 20,
  maxAttempts: 6,
  staleAfterSec: 3600,
  productCooldownSec: 600,
  skipOutOfStock: true,
  maxOutbox: 300,
  sentTtlSec: 30 * 86400,
  waitHorizonMs: 5000,
  httpTimeoutMs: 15000,
  runBudgetMs: 50000,
  heartbeatEveryMs: 15 * 60 * 1000,
  // Strict "never twice": if a send times out we cannot know if Telegram got it, so we do NOT resend.
  retryUnknownOutcome: false,

  dailyReport: { enabled: true, hour: 21, skipEmpty: true, channels: ['free', 'instant'], maxItems: 10 },

  telegramApiBase: 'https://api.telegram.org',
  telegramToken: '',
  storePrefix: 'bot:',
  retailers: defaultRetailers,
});

const bool = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  return /^(1|true|on|yes|ja)$/i.test(String(v).trim());
};
const num = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const list = (v) => String(v ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
// "otto=1234, cyberport=5678" -> { otto: "1234", cyberport: "5678" }
const pairs = (v) => Object.fromEntries(list(v).map((p) => p.split('=')).filter((x) => x.length === 2 && x[0] && x[1]).map(([k, x]) => [k.toLowerCase(), x]));

function deepMerge(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b === undefined ? a : b;
  const out = { ...(a && typeof a === 'object' && !Array.isArray(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) if (v !== undefined) out[k] = deepMerge(out[k], v);
  return out;
}

const str = (v) => (v === undefined || v === null || v === '' ? undefined : String(v).trim());

// Build config from env vars (process.env in Node, env in Workers) plus code overrides.
export function loadConfig(env = {}, overrides = {}) {
  let retailers;
  if (env.RETAILERS_JSON) {
    try { retailers = deepMerge(DEFAULTS.retailers, JSON.parse(env.RETAILERS_JSON)); }
    catch (e) { throw new Error(`RETAILERS_JSON is not valid JSON: ${e.message}`); }
  }
  const fromEnv = {
    brand: str(env.BRAND),
    channelUrl: str(env.CHANNEL_URL),
    impressumUrl: str(env.IMPRESSUM_URL),
    paidTier: bool(env.PAID_TIER, undefined),
    freeDelaySec: num(env.FREE_DELAY_SEC, undefined),
    joinUrl: str(env.JOIN_URL),
    channels: {
      instant: { chatId: str(env.INSTANT_CHAT_ID) },
      free: { chatId: str(env.FREE_CHAT_ID) },
    },
    discordWebhookUrl: str(env.DISCORD_WEBHOOK_URL),
    discordTier: str(env.DISCORD_TIER),
    adminIds: env.ADMIN_IDS ? list(env.ADMIN_IDS) : undefined,
    amazonTag: str(env.AMAZON_TAG),
    awinAffId: str(env.AWIN_AFFILIATE_ID),
    awinMids: env.AWIN_MIDS ? pairs(env.AWIN_MIDS) : undefined,
    amazonPriceAllowed: bool(env.AMAZON_PRICE_ALLOWED, undefined),
    trustLowest30dWithoutHistory: bool(env.TRUST_LOWEST30D_WITHOUT_HISTORY, undefined),
    showSpeedLine: bool(env.SHOW_SPEED_LINE, undefined),
    linkPreview: bool(env.LINK_PREVIEW, undefined),
    usePhotos: bool(env.USE_PHOTOS, undefined),
    defaultShipsByLabel: str(env.SHIPS_BEFORE_LABEL),
    shipsByLabels: env.SHIPS_BY && env.SHIPS_BEFORE_LABEL ? { [env.SHIPS_BY]: env.SHIPS_BEFORE_LABEL } : undefined,
    perChannelPerMinute: num(env.PER_CHANNEL_PER_MINUTE, undefined),
    maxPostsPerRun: num(env.MAX_POSTS_PER_RUN, undefined),
    staleAfterSec: num(env.STALE_AFTER_SEC, undefined),
    productCooldownSec: num(env.PRODUCT_COOLDOWN_SEC, undefined),
    waitHorizonMs: num(env.WAIT_HORIZON_MS, undefined),
    runBudgetMs: num(env.RUN_BUDGET_MS, undefined),
    dailyReport: {
      enabled: bool(env.DAILY_REPORT, undefined),
      hour: num(env.DAILY_REPORT_HOUR, undefined),
    },
    telegramApiBase: str(env.TELEGRAM_API_BASE),
    telegramToken: str(env.TELEGRAM_BOT_TOKEN),
    storePrefix: str(env.STORE_PREFIX),
    retailers,
  };
  return deepMerge(deepMerge(structuredClone(DEFAULTS), fromEnv), overrides);
}

// Delay mode only counts if there is a private channel to be "ahead" in. Otherwise the proof line would be false.
export function effectivePaid(cfg) {
  return Boolean(cfg.paidTier && cfg.channels?.instant?.chatId);
}

export function isPlaceholder(v) {
  return !v || /x{3,}|^paste|^your/i.test(String(v));
}

export function configWarnings(cfg) {
  const w = [];
  if (!cfg.telegramToken) w.push('TELEGRAM_BOT_TOKEN fehlt');
  if (!cfg.channels.free.chatId && !cfg.channels.instant.chatId) w.push('Kein Kanal gesetzt (FREE_CHAT_ID)');
  if (cfg.paidTier && !cfg.channels.instant.chatId) w.push('PAID_TIER an, aber INSTANT_CHAT_ID fehlt: alles läuft sofort');
  if (cfg.paidTier && !cfg.joinUrl) w.push('PAID_TIER an, aber JOIN_URL fehlt');
  if (isPlaceholder(cfg.amazonTag)) w.push('AMAZON_TAG fehlt: Amazon-Links ohne Provision');
  if (isPlaceholder(cfg.awinAffId)) w.push('AWIN_AFFILIATE_ID fehlt: Shop-Links ohne Provision');
  return w;
}
