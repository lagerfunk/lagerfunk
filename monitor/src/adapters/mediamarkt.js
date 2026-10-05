// MediaMarkt and Saturn share one platform (same product ids, same page). The first JSON-LD block (BuyAction ->
// ProductGroup -> offers) sits in the first ~1.5 % of a ~1 MB page, so we stop reading there: ~15 KB instead of 1 MB.
// Protection: Cloudflare (Turnstile key and /cdn-cgi/challenge-platform in the page).
// Retail product ids are 7 digits (3018022). Marketplace listings use 9-digit ids (165869416) and are third-party sellers.
import { BROWSER_HEADERS, parseStructured } from './common.js';
import { untilJsonLdOffers, firstMatch, parseDeliveryDate } from '../util.js';

function make(id, name, host, sellerRe) {
  return {
    id,
    name,
    hosts: [host],
    officialSeller: sellerRe,
    trustUnknownSeller: true,
    defaultIntervalSec: 60,
    proxy: 'fallback',
    request(item) {
      return { url: item.url, headers: BROWSER_HEADERS, stopWhen: item.fullPage ? null : untilJsonLdOffers };
    },
    parse(text, ctx) {
      const r = parseStructured(text, ctx);
      if (!r.ok) return r;
      const pid = firstMatch(ctx.item.url, /-(\d{6,})\.html/);
      const marketplace = pid ? pid.length >= 9 : false;
      // Exact fulfilment window from the Apollo state, only present when the full page was read.
      if (pid) {
        const earliest = firstMatch(text, new RegExp(`"CofrDeliveryFeature:\\w+:de:${pid}":\\{"__typename"[^{]*?"delivery":\\{[\\s\\S]{0,500}?"earliest":"([^"]+)"`));
        const status = firstMatch(text, new RegExp(`"CofrOnlineStatusFeature:\\w+:de:${pid}":\\{[^}]*?"onlineStatus":"([A-Z_]+)"`));
        if (earliest && r.inStock) r.deliveryEstimate = parseDeliveryDate(earliest, ctx.now);
        if (status) r.stockText = status;
      }
      if (r.soldBy) r.soldByRetailer = sellerRe.test(r.soldBy);
      else if (marketplace) {
        r.soldBy = 'Marketplace';
        r.soldByRetailer = false;
      } else {
        r.soldBy = name;
        r.soldByRetailer = true;
      }
      return r;
    },
  };
}

export const mediamarkt = make('mediamarkt', 'MediaMarkt', 'mediamarkt.de', /media\s*markt/i);
export const saturn = make('saturn', 'Saturn', 'saturn.de', /saturn/i);
