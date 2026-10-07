// Fixed channel texts. Telegram limits a channel description to 255 characters.
import { isPlaceholder } from './config.js';
export const AMAZON_LINE = 'Als Amazon-Partner verdiene ich an qualifizierten Verkäufen.';
export const AFFILIATE_LEGEND = 'Posts mit "Anzeige" enthalten Affiliate-Links: Ich erhalte bei Kauf eine Provision, für dich ändert sich der Preis nicht.';

// The Amazon sentence is only true for a member of the Amazon PartnerNet programme. Without AMAZON_LINKS=on and an AMAZON_TAG it must not appear.
export const isAmazonPartner = (cfg) => Boolean(cfg?.amazonLinks) && !isPlaceholder(cfg?.amazonTag);

const bare = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

/** The privacy page next to the Impressum: DATENSCHUTZ_URL, or the Impressum address with "impressum" replaced. */
export const datenschutzUrl = (cfg) => cfg?.datenschutzUrl || String(cfg?.impressumUrl || '').replace(/impressum(\.html)?$/i, 'datenschutz$1');

export function channelDescription(cfg) {
  const parts = [
    'PS5 Pro, Grafikkarten, RAM und SSDs: Restocks und Preisalarme aus deutschen Shops.',
    isAmazonPartner(cfg) ? 'Enthält Affiliate-Links (Anzeige).' : 'Affiliate-Links sind als Anzeige markiert.',
    isAmazonPartner(cfg) ? AMAZON_LINE : '',
  ].filter(Boolean).join(' ');
  const noBond = 'Kein Bezug zu Sony, Nvidia oder Shops.';
  const impressum = `Impressum: ${bare(cfg.impressumUrl)}`;
  const privacy = `Datenschutz: ${bare(datenschutzUrl(cfg))}`;
  // 255 characters is Telegram's limit. The Impressum always stays. If the text is too long the "Kein Bezug" sentence goes first,
  // then the privacy link (the pinned post carries both, in full).
  for (const text of [`${parts} ${noBond} ${impressum} · ${privacy}`, `${parts} ${impressum} · ${privacy}`, `${parts} ${noBond} ${impressum}`]) if (text.length <= 255) return text;
  return `${parts} ${impressum}`;
}

export function pinnedPost(cfg) {
  return [
    `📡 <b>${cfg.brand}</b>`,
    'Restocks, Preisalarme und Lieferdaten für PS5 Pro, GTA VI und Grafikkarten aus deutschen Shops. Jeder Fund kommt ohne künstliche Verzögerung hierher.',
    'Neu: RAM und SSDs. Preis, Shop und Stand bei jedem Fund, jeden Montag der Preisstand der wichtigsten Kits.',
    '',
    `🟢 Wieder da · 🚚 Lieferung vor GTA VI · 🔔 Preis-Alarm${cfg.dailyReport?.enabled ? ` · 📊 Tagesbericht um ${cfg.dailyReport.hour} Uhr` : ''}`,
    '',
    `<i>${AFFILIATE_LEGEND}${isAmazonPartner(cfg) ? ` ${AMAZON_LINE}` : ''}</i>`,
    '<i>Posts ohne "Anzeige" enthalten keinen Affiliate-Link.</i>',
    '<i>Preise und Verfügbarkeit: Stand der Erkennung, können sich ändern. Kein Kaufversprechen. Nicht mit Sony, Nvidia oder den Shops verbunden.</i>',
    `Impressum: ${cfg.impressumUrl}`,
    `Datenschutz: ${datenschutzUrl(cfg)}`,
  ].join('\n');
}

export function startText(cfg) {
  return [
    `📡 <b>${cfg.brand}</b>: Restocks und Preisalarme aus deutschen Shops.`,
    `Kanal: ${cfg.channelUrl}`,
    isAmazonPartner(cfg) ? AMAZON_LINE : '',
    `Impressum: ${cfg.impressumUrl}`,
    `Datenschutz: ${datenschutzUrl(cfg)}`,
  ].filter(Boolean).join('\n');
}
