// Affiliate link check, run on every link right before it goes into a post.
//
// Rule: a tracked link must carry OUR tag for the RIGHT shop, or the post goes out with the plain shop link and without
// "Anzeige". A post with a plain link earns nothing for that one click; a post with a broken or foreign link loses the
// reader's trust and can break the network's terms. Plain beats broken, every time.
//
// What is checked (expected values come from the config, never guessed):
//   Awin        awin1.com/cread.php (awinmid, awinaffid, ued) or awin1.com/pclick.php (m, a, p).
//               awinmid / m must be the shop's advertiser id, awinaffid / a our publisher id, ued a page of that shop.
//   Tradedoubler *.tradedoubler.com/click (p, a, url): p the shop's programme id, a our site id if we know it.
//   Amazon      OFF by default (AMAZON_LINKS): any tracked Amazon link fails with amazon:not_allowed. When switched on, the tag
//               must be our AMAZON_TAG. Short links (amzn.to) cannot be checked and count as failed.
//   Anything else that looks like a tracking link: unknown network, failed.
import { hostOf, isAmazonUrl, looksLikeAffiliateUrl } from './affiliate.js';
import { isPlaceholder } from './config.js';

const isHttp = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:';
  } catch {
    return false;
  }
};
const real = (v) => (isPlaceholder(v) ? null : String(v).trim());
const numeric = (v) => /^\d{1,12}$/.test(String(v ?? ''));
const hostMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`);

/** Is `url` a page of this retailer? Unknown retailers (no domain list) pass. */
export function onRetailerDomain(url, retailer) {
  if (!isHttp(url)) return false;
  const domains = retailer?.domains ?? [];
  if (!domains.length) return true;
  const h = hostOf(url);
  return domains.some((d) => hostMatches(h, d));
}

/**
 * Verify one tracked link. Returns { ok: true } or { ok: false, reason, target } where target is the shop page the
 * link points to when it can be read from the link itself.
 */
export function verifyAffiliateUrl(url, { retailer = null, cfg = {} } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'link:unparseable', target: null };
  }
  const host = hostOf(url);
  const p = (k) => u.searchParams.get(k);
  const expect = cfg.linkCheck ?? {};
  const rid = retailer?.id ?? null;

  if (hostMatches(host, 'awin1.com')) {
    const path = u.pathname.toLowerCase();
    let mid;
    let aff;
    let target = null;
    if (path.endsWith('/cread.php')) {
      mid = p('awinmid');
      aff = p('awinaffid');
      target = p('ued');
      if (!target || !isHttp(target)) return { ok: false, reason: 'awin:no_target', target: null };
      if (!onRetailerDomain(target, retailer)) return { ok: false, reason: 'awin:wrong_target', target: null };
    } else if (path.endsWith('/pclick.php')) {
      mid = p('m');
      aff = p('a');
      if (!p('p')) return { ok: false, reason: 'awin:no_product', target: null };
    } else {
      return { ok: false, reason: 'awin:unknown_path', target: null };
    }
    if (!numeric(mid)) return { ok: false, reason: 'awin:no_merchant', target };
    if (!numeric(aff)) return { ok: false, reason: 'awin:no_affiliate', target };
    const wantMid = (rid && (expect.awinMids?.[rid] ?? cfg.awinMids?.[rid])) ?? null;
    if (wantMid !== null && wantMid !== undefined && String(wantMid) !== String(mid)) return { ok: false, reason: 'awin:wrong_merchant', target };
    const wantAff = real(cfg.awinAffId);
    if (wantAff && wantAff !== String(aff)) return { ok: false, reason: 'awin:wrong_affiliate', target };
    return { ok: true, target };
  }

  if (hostMatches(host, 'tradedoubler.com')) {
    const prog = p('p');
    const site = p('a');
    const target = p('url');
    if (!numeric(prog)) return { ok: false, reason: 'td:no_program', target: null };
    if (!numeric(site)) return { ok: false, reason: 'td:no_site', target: null };
    if (target && (!isHttp(target) || !onRetailerDomain(target, retailer))) return { ok: false, reason: 'td:wrong_target', target: null };
    const wantProg = rid ? expect.tdPrograms?.[rid] ?? null : null;
    if (wantProg !== null && String(wantProg) !== String(prog)) return { ok: false, reason: 'td:wrong_program', target };
    const wantSite = real(expect.tdSiteId);
    if (wantSite && wantSite !== String(site)) return { ok: false, reason: 'td:wrong_site', target };
    return { ok: true, target };
  }

  if (isAmazonUrl(url)) {
    if (!cfg.amazonLinks) return { ok: false, reason: 'amazon:not_allowed', target: null };
    if (host.startsWith('amzn.')) return { ok: false, reason: 'amazon:short_link', target: null };
    const tag = p('tag');
    const want = real(cfg.amazonTag);
    if (!tag) return { ok: false, reason: 'amazon:no_tag', target: null };
    if (!want || want !== tag) return { ok: false, reason: 'amazon:wrong_tag', target: null };
    return { ok: true, target: null };
  }

  return { ok: false, reason: 'link:unknown_network', target: null };
}

/**
 * The guard the engine applies to every link: { url, affiliate, program } in, the same shape out.
 * A failed tracked link is replaced by a plain shop link (alert.shopUrl from the watch list, else the target inside
 * the tracked link) with affiliate=false, so the post loses "Anzeige" and never carries a broken link.
 * Returns null when no clean link exists at all: the caller must not post.
 */
export function guardLink(link, { alert = {}, retailer = null, cfg = {} } = {}) {
  if (!link || !link.url) return null;
  if (cfg.linkCheck?.enabled === false) return link;
  if (!link.affiliate) return { ...link, checked: 'plain' };
  const v = verifyAffiliateUrl(link.url, { retailer, cfg });
  if (v.ok) return { ...link, checked: 'ok' };
  const candidates = [alert.shopUrl, v.target, alert.url];
  const plain = candidates.find((c) => c && isHttp(c) && !looksLikeAffiliateUrl(c) && onRetailerDomain(c, retailer));
  if (!plain) return null;
  return { url: plain, affiliate: false, program: 'none', checked: 'fallback', reason: v.reason };
}
