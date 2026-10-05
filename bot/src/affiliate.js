// Affiliate link builder. Per-retailer config lives in config/retailers.js, IDs come from env.
import { isPlaceholder } from './config.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}
const hostMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`);

export function isAmazonUrl(url) {
  const h = hostOf(url);
  return /(^|\.)amazon\.[a-z.]+$/.test(h) || h === 'amzn.to' || h === 'amzn.eu';
}

// Hosts that only exist to track affiliate clicks. If an incoming URL already uses one, the post is an ad.
const AFFILIATE_HOSTS = ['awin1.com', 'amzn.to', 'amzn.eu', 'tradedoubler.com', 'webgains.com', 'partners.webmasterplan.com', 'shareasale.com', 'click.linksynergy.com', 'prf.hn', 'tidd.ly'];

export function looksLikeAffiliateUrl(url) {
  const h = hostOf(url);
  if (!h) return false;
  if (AFFILIATE_HOSTS.some((d) => hostMatches(h, d))) return true;
  if (isAmazonUrl(url)) {
    try { return new URL(url).searchParams.has('tag'); } catch { return false; }
  }
  return false;
}

// Retailer config for an alert: by id, name or alias first, then by URL domain. Unknown shop -> plain link.
export function resolveRetailer(alert, cfg) {
  const retailers = cfg.retailers || {};
  const want = norm(alert.retailer);
  if (want) {
    for (const [id, r] of Object.entries(retailers)) {
      if ([id, r.name, ...(r.aliases || [])].map(norm).includes(want)) return { id, ...r };
    }
  }
  const host = hostOf(alert.url);
  if (host) {
    for (const [id, r] of Object.entries(retailers)) {
      if ((r.domains || []).some((d) => hostMatches(host, d))) return { id, ...r };
    }
  }
  const raw = String(alert.retailer || '').trim();
  const name = !raw || raw === 'generic' || raw === 'unknown' ? host || 'Shop' : raw;
  return { id: norm(name) || 'unknown', name, program: 'none', listPriceIsUvp: false };
}

const firstReal = (...vals) => vals.find((v) => !isPlaceholder(v));

function stripAmazonTag(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('tag');
    u.searchParams.delete('ascsubtag');
    u.searchParams.delete('linkCode');
    return u.toString();
  } catch { return rawUrl; }
}

// Returns { url, affiliate, program }. affiliate=true means the post must start with "Anzeige".
// opts.privateChannel: true for a closed channel. Amazon only pays for links in public places, and a tagged
// link there would break its rules, so it gets a plain link.
export function buildLink(rawUrl, retailer, cfg, opts = {}) {
  const passthrough = { url: rawUrl, affiliate: looksLikeAffiliateUrl(rawUrl), program: 'none' };
  if (!retailer) return passthrough;

  if (retailer.program === 'amazon' || (isAmazonUrl(rawUrl) && retailer.program !== 'none')) {
    if (opts.privateChannel && retailer.publicOnly !== false) {
      const url = stripAmazonTag(rawUrl);
      return { url, affiliate: looksLikeAffiliateUrl(url), program: 'none' };
    }
    const tag = firstReal(retailer.amazonTag, cfg.amazonTag);
    if (!tag || !isAmazonUrl(rawUrl) || hostOf(rawUrl).startsWith('amzn.')) return passthrough;
    try {
      const u = new URL(stripAmazonTag(rawUrl));
      u.searchParams.set('tag', tag);
      return { url: u.toString(), affiliate: true, program: 'amazon' };
    } catch { return passthrough; }
  }

  if (retailer.program === 'awin') {
    const mid = firstReal(cfg.awinMids?.[retailer.id], retailer.awinMid);
    const aff = firstReal(retailer.awinAffId, cfg.awinAffId);
    if (!mid || !aff || looksLikeAffiliateUrl(rawUrl)) return passthrough;
    const url = `https://www.awin1.com/cread.php?awinmid=${encodeURIComponent(mid)}&awinaffid=${encodeURIComponent(aff)}&ued=${encodeURIComponent(rawUrl)}`;
    return { url, affiliate: true, program: 'awin' };
  }

  return passthrough;
}
