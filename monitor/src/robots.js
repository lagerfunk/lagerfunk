// robots.txt reader (RFC 9309), runtime neutral. Used to REPORT whether a page we read is open to automated access:
// the smoke test prints a verdict per shop, `scripts/robots-check.js` prints it on demand. It never changes what the
// monitor fetches by itself: the owner decides what to do with a "disallowed" (switch the shop to its feed, or off).
//
// Rules applied: the group for our own token ("lagerfunk") wins over "*"; the longest matching pattern wins; Allow wins a
// tie; "*" matches anything and "$" anchors the end; an empty Disallow allows everything. A missing robots.txt (4xx)
// allows everything; a 5xx or no answer is "unknown" (RFC 9309 says to treat it as disallowed, we report it and move on).

export const ROBOTS_AGENT = 'lagerfunk';

/** @returns {{ agents: string[], rules: { allow: boolean, pattern: string }[] }[]} */
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      lastWasAgent = false;
      if (cur) cur.rules.push({ allow: key === 'allow', pattern: value });
    } else lastWasAgent = false;
  }
  return groups;
}

function toRegExp(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Verdict for one URL against a robots.txt body. */
export function robotsVerdict(text, url, { agent = ROBOTS_AGENT } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { allowed: false, rule: null, reason: 'bad_url' };
  }
  const groups = parseRobots(text);
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.toLowerCase().includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  const target = `${u.pathname}${u.search}`;
  let best = null;
  for (const g of chosen) {
    for (const r of g.rules) {
      if (!r.pattern) continue; // empty Disallow = allow all, empty Allow = nothing
      if (!toRegExp(r.pattern).test(target)) continue;
      const len = r.pattern.replace(/\$$/, '').length;
      if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow, pattern: r.pattern };
    }
  }
  return best && !best.allow ? { allowed: false, rule: `Disallow: ${best.pattern}` } : { allowed: true, rule: best ? `Allow: ${best.pattern}` : null };
}

/**
 * Fetch robots.txt once per host and judge every URL. `entries` = [{ id, url }] (the URL the monitor really requests).
 * @returns {Promise<{ host: string, status: 'ok'|'missing'|'unknown', checked: number, disallowed: { id: string, rule: string }[] }[]>}
 */
export async function robotsReport(entries, { fetch: fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = 15000, agent = ROBOTS_AGENT, headers = { 'user-agent': `${agent} (price and stock monitor)` } } = {}) {
  const byHost = new Map();
  for (const e of entries) {
    let host;
    try {
      host = new URL(e.url).origin;
    } catch {
      continue;
    }
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(e);
  }
  const out = [];
  for (const [origin, list] of byHost) {
    let status = 'unknown';
    let text = '';
    try {
      const res = await fetchImpl(`${origin}/robots.txt`, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 200 && res.status < 300) {
        status = 'ok';
        text = (await res.text()).slice(0, 500000);
      } else if (res.status >= 400 && res.status < 500) status = 'missing';
    } catch {
      status = 'unknown';
    }
    const disallowed = status === 'ok' ? list.map((e) => ({ id: e.id, v: robotsVerdict(text, e.url, { agent }) })).filter((x) => !x.v.allowed).map((x) => ({ id: x.id, rule: x.v.rule })) : [];
    out.push({ host: new URL(origin).host, status, checked: list.length, disallowed });
  }
  return out;
}
