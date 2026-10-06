// Staging and promotion.
//
// The repository variable LAGERFUNK_CHANNEL decides where posts go:
//   staging  every post goes to the private test channel TELEGRAM_CHAT_ID_STAGING (a secret). Nothing reaches the
//            public channel. Without that secret a staging run posts nowhere (learns only) and says so.
//   public   posts go to the public channel (@lagerfunk from brand.json, or FREE_CHAT_ID).
// The workflow defaults to staging, so the first live runs after setup can only ever reach the test channel.
// Locally (no variable set) the runner keeps its old behaviour: FREE_CHAT_ID.
//
// Promotion is one command, run where the GitHub CLI is logged in (a clone of the runner repository):
//   node deploy/ops.mjs promote          checks the staging record first, then sets LAGERFUNK_CHANNEL=public
//   node deploy/ops.mjs demote           back to staging at once (no checks)
// Without the CLI: GitHub, Settings, Secrets and variables, Actions, Variables, LAGERFUNK_CHANNEL = public.
export const CHANNELS = ['staging', 'public'];
export const CHANNEL_VAR = 'LAGERFUNK_CHANNEL';

/**
 * @returns {{ channel: 'staging'|'public', posting: boolean, reason: string|null, envPatch: object }}
 */
export function resolveChannel(env = {}) {
  const raw = String(env[CHANNEL_VAR] ?? '').trim().toLowerCase();
  if (raw && !CHANNELS.includes(raw)) throw new Error(`${CHANNEL_VAR} must be "staging" or "public", not "${raw}". Fix the repository variable.`);
  if (raw !== 'staging') return { channel: 'public', posting: true, reason: null, envPatch: {} };
  const chat = String(env.TELEGRAM_CHAT_ID_STAGING ?? '').trim();
  // In staging the private tier, Discord and anything else that could reach the public are switched off.
  const envPatch = { FREE_CHAT_ID: chat, INSTANT_CHAT_ID: '', PAID_TIER: 'off', DISCORD_WEBHOOK_URL: '' };
  if (!chat) return { channel: 'staging', posting: false, reason: 'TELEGRAM_CHAT_ID_STAGING is not set: staging posts nowhere. Add the secret, or promote to public.', envPatch };
  return { channel: 'staging', posting: true, reason: null, envPatch };
}

/**
 * May staging be promoted? Reads what the runner wrote to the state branch (status.json and activity.jsonl lines).
 * @returns {{ ok: boolean, reasons: string[], warnings: string[], facts: object }}
 */
export function promotionGate({ status = null, lines = [], now = Date.now(), cfg }) {
  const c = cfg.promotion;
  const reasons = [];
  const warnings = [];
  const day = lines.filter((l) => now - Date.parse(l.at) <= 86400000);
  const good = day.filter((l) => l.ok).length;
  const failed = day.filter((l) => !l.ok).length;
  const posts = lines.reduce((n, l) => n + (l.channel === 'staging' ? l.alerts?.sent ?? 0 : 0), 0);
  const open = status?.breakers?.retailersOpen ?? [];
  const tg = status?.breakers?.telegram ?? 'closed';
  if (status?.channel && status.channel !== 'staging') reasons.push(`the runner reports channel "${status.channel}", not staging`);
  if (good < c.minGoodRuns24h) reasons.push(`${good} good runs in the last 24 h, need ${c.minGoodRuns24h}`);
  if (failed > c.maxFailedRuns24h) reasons.push(`${failed} failed runs in the last 24 h, allowed ${c.maxFailedRuns24h}`);
  if (open.length > c.maxOpenBreakers) reasons.push(`shop breakers open: ${open.join(', ')}`);
  if (tg !== 'closed') reasons.push(`the Telegram breaker is ${tg}`);
  if ((status?.health ?? 'ok') === 'down') reasons.push('status.json says health "down"');
  if (posts === 0) warnings.push('no post has reached the staging channel yet, so the post path is only proven by the smoke test');
  return { ok: reasons.length === 0, reasons, warnings, facts: { good, failed, posts, open, telegram: tg } };
}

/**
 * Set the repository variable with the GitHub CLI. `exec(cmd, args)` is injectable for tests.
 * @returns {{ ok: boolean, command: string[], output?: string, error?: string }}
 */
export async function setChannel({ to, repo = null, exec, dryRun = false }) {
  if (!CHANNELS.includes(to)) throw new Error(`unknown channel "${to}"`);
  const args = ['variable', 'set', CHANNEL_VAR, '--body', to, ...(repo ? ['--repo', repo] : [])];
  if (dryRun) return { ok: true, command: ['gh', ...args], dryRun: true };
  try {
    const output = await exec('gh', args);
    return { ok: true, command: ['gh', ...args], output };
  } catch (e) {
    return { ok: false, command: ['gh', ...args], error: e.message };
  }
}
