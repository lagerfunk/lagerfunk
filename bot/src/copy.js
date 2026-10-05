// Fixed channel texts. Telegram limits a channel description to 255 characters.
import { isPlaceholder } from './config.js';
export const AMAZON_LINE = 'Als Amazon-Partner verdiene ich an qualifizierten Verkäufen.';
export const AFFILIATE_LEGEND = 'Posts mit "Anzeige" enthalten Affiliate-Links: Ich erhalte bei Kauf eine Provision, für dich ändert sich der Preis nicht.';

// The Amazon sentence is only true for a member of the Amazon PartnerNet programme. Without an AMAZON_TAG it must not appear.
export const isAmazonPartner = (cfg) => !isPlaceholder(cfg?.amazonTag);

const bare = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

export function channelDescription(cfg) {
  return [
    'PS5 Pro, GTA VI, Grafikkarten: Restocks und Preisalarme aus deutschen Shops.',
    'Enthält Affiliate-Links (Anzeige).',
    isAmazonPartner(cfg) ? AMAZON_LINE : '',
    'Kein Bezug zu Sony, Nvidia oder Shops.',
    `Impressum: ${bare(cfg.impressumUrl)}`,
  ].filter(Boolean).join(' ');
}

export function pinnedPost(cfg) {
  return [
    `📡 <b>${cfg.brand}</b>`,
    'Restocks, Preisalarme und Lieferdaten für PS5 Pro, GTA VI und Grafikkarten aus deutschen Shops. Jeder Fund kommt ohne künstliche Verzögerung hierher.',
    '',
    `🟢 Wieder da · 🚚 Lieferung vor GTA VI · 🔔 Preis-Alarm${cfg.dailyReport?.enabled ? ` · 📊 Tagesbericht um ${cfg.dailyReport.hour} Uhr` : ''}`,
    '',
    `<i>${AFFILIATE_LEGEND}${isAmazonPartner(cfg) ? ` ${AMAZON_LINE}` : ''}</i>`,
    '<i>Preise und Verfügbarkeit: Stand der Erkennung, können sich ändern. Kein Kaufversprechen. Nicht mit Sony, Nvidia oder den Shops verbunden.</i>',
    `Impressum: ${cfg.impressumUrl}`,
  ].join('\n');
}

export function startText(cfg) {
  return [
    `📡 <b>${cfg.brand}</b>: Restocks und Preisalarme aus deutschen Shops.`,
    `Kanal: ${cfg.channelUrl}`,
    isAmazonPartner(cfg) ? AMAZON_LINE : '',
    `Impressum: ${cfg.impressumUrl}`,
  ].filter(Boolean).join('\n');
}
