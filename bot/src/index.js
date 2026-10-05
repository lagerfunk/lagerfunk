// Public entry. Runtime neutral (Node 22 and Cloudflare Workers).
export { createEngine } from './engine.js';
export { loadConfig, DEFAULTS, effectivePaid, configWarnings } from './config.js';
export { buildLink, resolveRetailer, looksLikeAffiliateUrl, isAmazonUrl } from './affiliate.js';
export { priceFacts, assertCompliant } from './pricing.js';
export { renderAlertPost, renderDailyReport, cleanTitle, dateDE } from './format.js';
export { channelDescription, pinnedPost, startText, isAmazonPartner, AMAZON_LINE, AFFILIATE_LEGEND } from './copy.js';
export { createTelegram, createDiscord, SendError } from './telegram.js';
export { memoryStore } from './stores/memory.js';
export { kvStore } from './stores/kv.js';
export { upstashStore } from './stores/upstash.js';
