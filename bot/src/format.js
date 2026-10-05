// German post copy. One model, two renderings: Telegram HTML and Discord markdown.
// Baked-in rules: "Anzeige" first whenever an affiliate link is present, no percent discounts, UVP and 30-day
// wording only when pricing.js allows it, no em dashes anywhere.
import { escapeHtml as esc, formatEuro, berlinTime, berlinDateDE, truncate, isHttpUrl } from './util.js';
import { assertCompliant } from './pricing.js';

const KIND = {
  restock: { emoji: '🟢', label: 'WIEDER DA' },
  price_drop: { emoji: '🔔', label: 'PREIS-ALARM' },
  lowest_30d: { emoji: '📉', label: '30-TAGE-TIEFSTPREIS' },
};

// Retailer titles sometimes carry "-20%" or "statt 99 €"; strip that so the post never implies a reduction.
export function cleanTitle(t) {
  return truncate(
    String(t ?? '')
      .replace(/[\u2014\u2013]/g, '-')
      .replace(/[-]?\s*\d+([.,]\d+)?\s*%\s*(rabatt|reduziert|off|sparen)?/gi, '')
      .replace(/\b(statt|vorher|uvp)\b\s*[\d.,]+\s*(€|eur)?/gi, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s\-|:,]+|[\s\-|:,]+$/g, '')
      .trim() || 'Produkt',
    140,
  );
}

function mdEscape(s) {
  return String(s ?? '').replace(/([\\*_~`|>[\]()#])/g, '\\$1');
}

export function delayText(sec) {
  if (sec % 60 === 0) { const m = sec / 60; return m === 1 ? '1 Minute' : `${m} Minuten`; }
  return `${sec} Sekunden`;
}

// "2026-11-12" -> "12.11.2026"
export function dateDE(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
}

function shipsLabel(alert, cfg) {
  const by = String(alert.shipsBy ?? '').slice(0, 10);
  if (!by) return cfg.defaultShipsByLabel || null;
  return cfg.shipsByLabels?.[by] ?? null;
}

function headline(alert, facts, cfg) {
  if (alert.kind === 'ships_before') {
    const d = dateDE(alert.deliveryEstimate);
    const when = d ? `${alert.deliveryAssumed ? 'ca. ' : ''}${d}` : 'rechtzeitig';
    const label = shipsLabel(alert, cfg);
    const text = label ? `Lieferung vor ${label}: ${when}` : `Lieferung bis ${dateDE(alert.shipsBy) || 'Stichtag'}: ${when}`;
    return { emoji: '🚚', text, upper: false };
  }
  const k = alert.kind === 'lowest_30d' && !facts.lowest30dClaim ? 'price_drop' : alert.kind;
  const h = KIND[k] || KIND.price_drop;
  return { emoji: h.emoji, text: h.label, upper: true };
}

function stockLine(alert) {
  const d = dateDE(alert.deliveryEstimate);
  const showDate = d && alert.kind !== 'ships_before';
  // Shop wording only when it is human text ("Nur noch 2 auf Lager"); machine states and delivery text are covered above.
  const st = String(alert.stockText ?? '');
  const extra = /login/i.test(st) ? ' · Login nötig'
    : st && !/^(in ?stock|out ?of ?stock|pre ?order|back ?order)\b/i.test(st) && !/lieferung|versand/i.test(st) ? ` (${truncate(st, 40)})` : '';
  if (alert.isPreorder) return `🗓️ Vorbestellbar${showDate ? `, Lieferung ab ${d}` : ''}`;
  if (alert.isBackorder) return `⏳ Bestellbar${showDate ? `, Lieferung erst ab ${d}` : ', noch nicht auf Lager'}`;
  if (alert.inStock === false) return `❌ Ausverkauft${extra}`;
  if (alert.inStock === true || alert.kind === 'restock' || alert.kind === 'ships_before') {
    return `✅ Auf Lager${extra}${showDate ? ` · Lieferung ${alert.deliveryAssumed ? 'ca.' : 'ab'} ${d}` : ''}`;
  }
  return '📦 Verfügbarkeit im Shop prüfen';
}

function speed(detectedAt, now) {
  const s = Math.max(0, Math.round((now - detectedAt) / 1000));
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} Min`;
}

// ctx: { cfg, paid, tier: 'instant'|'free', retailer, link, facts, detectedAt, instantAt, now }
export function renderAlertPost(alert, ctx) {
  const { cfg, paid, tier, retailer, link, facts, detectedAt, instantAt, now } = ctx;
  const tg = [];
  const dc = [];
  const check = [];
  const add = (t, d = t, c = d) => { tg.push(t); dc.push(d); check.push(c); };

  if (link.affiliate) add('<b>Anzeige</b>', '**Anzeige**', 'Anzeige');

  const h = headline(alert, facts, cfg);
  const shop = retailer.name || 'Shop';
  add(`${h.emoji} <b>${esc(h.text)}</b> · ${esc(shop)}`, `${h.emoji} **${mdEscape(h.text)}** · ${mdEscape(shop)}`, `${h.text} ${shop}`);

  const title = cleanTitle(alert.title);
  tg.push(`<b>${esc(title)}</b>`); dc.push(`**${mdEscape(title)}**`);
  add('', '', '');

  if (facts.pricesHidden) {
    add('💶 Preis: aktuell bei Amazon ansehen');
  } else if (facts.price !== null) {
    const p = formatEuro(facts.price);
    const uvp = facts.uvp !== null ? ` · UVP ${formatEuro(facts.uvp)}` : '';
    add(`💶 <b>${p}</b>${uvp}`, `💶 **${p}**${uvp}`, `${p}${uvp}`);
  }
  if (facts.lowest30dClaim) add('📉 Tiefster Preis der letzten 30 Tage');
  add(stockLine(alert));
  add(
    `🔗 <a href="${esc(link.url)}">Zum Angebot bei ${esc(shop)}</a>`,
    `🔗 [Zum Angebot bei ${mdEscape(shop)}](<${link.url}>)`,
    `Zum Angebot bei ${shop}`,
  );

  const proof = paid && tier === 'free';
  const stamp = `🕒 Stand ${berlinDateDE(detectedAt)}, ${berlinTime(detectedAt)} Uhr`;
  add(!proof && cfg.showSpeedLine ? `${stamp} · gepostet nach ${speed(detectedAt, now)}` : stamp);
  if (facts.amazon && !facts.pricesHidden && facts.price !== null) add('<i>Preise und Verfügbarkeit können sich ändern.</i>', '*Preise und Verfügbarkeit können sich ändern.*', '');

  const buttons = [[{ text: `🛒 Zum Angebot bei ${truncate(shop, 24)}`, url: link.url }]];
  if (proof) {
    const join = isHttpUrl(cfg.joinUrl) ? cfg.joinUrl : '';
    add('', '', '');
    const head = instantAt
      ? `Instant-Mitglieder hatten das um ${berlinTime(instantAt)}. Hier: ${berlinTime(now)}.`
      : `Instant-Mitglieder bekommen jeden Drop ${delayText(cfg.freeDelaySec)} früher.`;
    let t = `<blockquote>⚡ <b>${head}</b>`;
    let d = `> ⚡ **${head}**`;
    if (join) {
      t += `\n<a href="${esc(join)}">Ohne Wartezeit: Instant beitreten</a>`;
      d += `\n> [Ohne Wartezeit: Instant beitreten](<${join}>)`;
      buttons.push([{ text: '⚡ Instant beitreten', url: join }]);
    }
    t += '</blockquote>';
    tg.push(t); dc.push(d); check.push(head);
  }

  assertCompliant(check.join('\n'));
  const html = tg.join('\n').replace(/\n{3,}/g, '\n\n');
  const discord = dc.join('\n').replace(/\n{3,}/g, '\n\n');
  if (/\u2014/.test(html + discord)) throw new Error('Em dash in post');
  return {
    html,
    discord,
    buttons,
    previewUrl: alert.url,
    photo: cfg.usePhotos && isHttpUrl(alert.imageUrl) ? alert.imageUrl : null,
    affiliate: link.affiliate,
  };
}

// Tagesbericht. items: { restocks: [{title, retailer, link, at, delivery, ships}], prices: [{title, retailer, link, price}] }
export function renderDailyReport(items, ctx) {
  const { cfg, paid, tier, now, maxItems = 10 } = ctx;
  const all = [...items.restocks, ...items.prices];
  const affiliate = all.some((i) => i.link.affiliate);
  const tg = [];
  const dc = [];
  if (affiliate) { tg.push('<b>Anzeige</b>'); dc.push('**Anzeige**'); }
  tg.push(`📊 <b>Tagesbericht ${berlinDateDE(now)}</b>`);
  dc.push(`📊 **Tagesbericht ${berlinDateDE(now)}**`);

  const section = (emoji, label, rows, fmt) => {
    if (!rows.length) return;
    tg.push('', `${emoji} <b>${label} (${rows.length})</b>`);
    dc.push('', `${emoji} **${label} (${rows.length})**`);
    for (const r of rows.slice(0, maxItems)) {
      const [t, d] = fmt(r);
      tg.push(t); dc.push(d);
    }
    if (rows.length > maxItems) {
      tg.push(`<i>+ ${rows.length - maxItems} weitere</i>`);
      dc.push(`*+ ${rows.length - maxItems} weitere*`);
    }
  };
  section('🟢', 'Heute wieder da', items.restocks, (r) => {
    const title = truncate(cleanTitle(r.title), 60);
    const extra = `${esc(r.retailer)} · ${berlinTime(r.at).slice(0, 5)}${r.delivery ? ` · Lieferung ${r.ships ? 'vor ' + esc(r.ships) + ': ' : 'ab '}${dateDE(r.delivery)}` : ''}`;
    return [
      `• <a href="${esc(r.link.url)}">${esc(title)}</a> · ${extra}`,
      `• [${mdEscape(title)}](<${r.link.url}>) · ${extra}`,
    ];
  });
  section('💶', 'Beste Preise heute', items.prices, (r) => {
    const title = truncate(cleanTitle(r.title), 60);
    const p = r.price === null ? 'Preis im Shop' : formatEuro(r.price);
    return [
      `• <a href="${esc(r.link.url)}">${esc(title)}</a> · <b>${p}</b> · ${esc(r.retailer)}`,
      `• [${mdEscape(title)}](<${r.link.url}>) · **${p}** · ${mdEscape(r.retailer)}`,
    ];
  });

  if (paid && tier === 'free' && isHttpUrl(cfg.joinUrl)) {
    const line = `Instant-Mitglieder sehen jeden Drop ${delayText(cfg.freeDelaySec)} früher.`;
    tg.push('', `<blockquote>⚡ <b>${line}</b>\n<a href="${esc(cfg.joinUrl)}">Instant beitreten</a></blockquote>`);
    dc.push('', `> ⚡ **${line}**\n> [Instant beitreten](<${cfg.joinUrl}>)`);
  }
  tg.push('', '<i>Preise und Verfügbarkeit: Stand der Erkennung, können sich ändern.</i>');
  dc.push('', '*Preise und Verfügbarkeit: Stand der Erkennung, können sich ändern.*');

  const html = tg.join('\n');
  if (/\u2014/.test(html)) throw new Error('Em dash in report');
  return { html, discord: dc.join('\n'), buttons: null, previewUrl: null, photo: null, affiliate };
}
