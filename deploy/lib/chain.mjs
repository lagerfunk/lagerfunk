// The self-chaining runner. GitHub's scheduler delivered 4 of about 48 scheduled runs overnight, so a cron every 10 minutes
// cannot be the clock. Instead ONE workflow run stays alive for about 50 minutes, does a cycle every 10 minutes (a cycle is
// one `node deploy/run.mjs`: read state, check, guard, post, push state), and shortly before its end starts the next run of
// the same workflow through the API (workflow_dispatch created with the job token DOES start a run; that is the documented
// exception to "the token cannot trigger workflows"). The cron stays as a safety net that restarts a broken chain.
//
// Rules (each one is tested in test/chain.test.mjs):
//   cycles       tick k starts at start + k * interval. A cycle is killed after cycleTimeoutMinutes, which is below the
//                interval, so cycles never overlap. The last tick is the last one that still ends before the hand-over.
//   feeds        the runner decides, not the loop: mode "auto" = watch, plus the feeds when the last feeds run is an hour old.
//   hand-over    handoffLeadSeconds before the loop ends: if no other run of this workflow is queued or running, dispatch the
//                next one. If one is queued (a cron run, a smoke-test run, a manual run) it takes over when this run ends, so
//                nothing is dispatched: that is the guard against two chains. The workflow's concurrency group (without
//                cancel-in-progress) makes a second chain impossible to run in parallel in the first place.
//   start guard  a run that finds another run of this workflow already IN PROGRESS (the lower run id wins) exits at once.
//   stop         the pause variable, a disabled workflow, a queued manual or smoke-test run, a moved last-known-good tag and
//                too many failed cycles in a row all end the loop early. Pause (chain.pauseStopsChain, on by default) and the
//                failure breaker never dispatch a successor: the chain stays stopped (cron and manual runs still do one cycle
//                each). With pauseStopsChain off a pause only holds the posts, as before the chain: the chain keeps checking.
//   manual runs  a manual run without "chain" does one cycle with its own inputs, then makes sure a chain exists.
//
// Everything with side effects is injected (clock, sleep, API, cycle runner, code version), so the tests drive it in virtual time.
import { spawn } from 'node:child_process';
import { collectSecrets, scrub } from './secrets.mjs';
import { personalValues, scrubPersonal } from './log.mjs';

const MIN = 60000;
export const WORKFLOW_FILE = 'lagerfunk.yml';
export const PAUSE_VARIABLE = 'LAGERFUNK_PAUSE';
/** Same words as the runner's own switch (deploy/lib/runner.mjs), so the loop and the runner never disagree about "paused". */
export const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());
/** The workflow flags that apply to the first cycle of a run only: a chain must not stay silent, dry or releasing for 50 minutes. */
export const ONE_SHOT_FLAGS = ['DRY_RUN', 'SILENT', 'FORCE', 'RELEASE_HELD'];

/** True when the feeds are due: never fetched, or the last feeds cycle is (every - slack) minutes old. Slack absorbs timer jitter. */
export function feedsDue({ lastFeedsAt, now, everyMinutes = 60, slackMinutes = 3 }) {
  const last = Number(lastFeedsAt);
  if (!Number.isFinite(last) || last <= 0 || last > now + 5 * MIN) return true;
  return now - last >= (everyMinutes - slackMinutes) * MIN;
}

/**
 * When the cycles of one run start, in ms after the loop started, and when the hand-over happens.
 * A cycle only starts when it can still be killed by its timeout before the hand-over time, so a run never outlives its job.
 */
export function planChain(chain) {
  const loopMs = chain.loopMinutes * MIN;
  if (loopMs <= 0) return { loopMs: 0, handoffAt: 0, ticks: [0] };
  const interval = Math.max(1, chain.intervalMinutes) * MIN;
  const handoffAt = Math.max(0, loopMs - chain.handoffLeadSeconds * 1000);
  const ticks = [0];
  for (let t = interval; t + chain.cycleTimeoutMinutes * MIN <= handoffAt; t += interval) ticks.push(t);
  return { loopMs, handoffAt, ticks };
}

/** Runs of the workflow that are not finished, newest first, without the run that asks. */
export function otherActiveRuns(runs, selfId) {
  return (runs ?? [])
    .filter((r) => String(r.id) !== String(selfId) && r.status !== 'completed')
    .sort((a, b) => Number(b.id) - Number(a.id));
}

// ---------- GitHub API (the job token, actions: write) ----------

/** Minimal REST client. Every call resolves to { ok, status, json, error } and never throws. */
export function createGithubApi({ env = process.env, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), file = WORKFLOW_FILE } = {}) {
  const base = env.GITHUB_API_URL || 'https://api.github.com';
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  async function call(method, path, body = null) {
    if (!repo || !token) return { ok: false, status: 0, json: null, error: 'GITHUB_REPOSITORY or GITHUB_TOKEN not set' };
    try {
      const res = await fetchImpl(`${base}/repos/${repo}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: res.ok, status: res.status, json, error: res.ok ? null : json?.message ?? `http ${res.status}` };
    } catch (e) {
      return { ok: false, status: 0, json: null, error: e.message };
    }
  }
  return {
    listRuns: () => call('GET', `/actions/workflows/${file}/runs?per_page=50`),
    workflowState: () => call('GET', `/actions/workflows/${file}`),
    variable: (name) => call('GET', `/actions/variables/${encodeURIComponent(name)}`),
    dispatch: ({ ref, inputs = {} }) => call('POST', `/actions/workflows/${file}/dispatches`, { ref, inputs }),
  };
}

// ---------- one cycle as a child process ----------

/**
 * Run `node <script> --mode <mode>` and resolve when it ends. A cycle that outlives timeoutMs is terminated (SIGTERM, then
 * SIGKILL) and counts as failed. Output goes straight to this process's stdout and stderr (the runner scrubs it itself).
 */
export function spawnCycle({ script, mode, env, timeoutMs, cwd = process.cwd(), killGraceMs = 5000, onChild = () => {} }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timedOut = false;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onChild(null);
      resolve({ ...r, ms: Date.now() - startedAt });
    };
    const child = spawn(process.execPath, [script, '--mode', mode], { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
    onChild(child);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), killGraceMs).unref();
    }, timeoutMs);
    child.on('error', (e) => done({ ok: false, code: null, timedOut, error: e.message }));
    child.on('close', (code, signal) => done({ ok: code === 0 && !timedOut, code, signal, timedOut }));
  });
}

// ---------- the code version (last-known-good) ----------

/** The commit a `git ls-remote origin refs/tags/last-known-good refs/tags/last-known-good^{}` answer points at (the peeled one for an annotated tag). */
export function parseTagCommit(text) {
  let plain = null;
  let peeled = null;
  for (const line of String(text ?? '').split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) continue;
    if (ref === 'refs/tags/last-known-good') plain = sha;
    else if (ref === 'refs/tags/last-known-good^{}') peeled = sha;
  }
  return peeled ?? plain;
}

/** { start, current } for runChain: the commit checked out now, and the commit production (the tag) points at. */
export async function codeVersion({ git }) {
  let start = null;
  try {
    start = (await git(['rev-parse', 'HEAD'])).trim() || null;
  } catch {
    start = null;
  }
  return { start, current: async () => parseTagCommit(await git(['ls-remote', 'origin', 'refs/tags/last-known-good', 'refs/tags/last-known-good^{}'])) };
}

// ---------- the loop ----------

/**
 * @param {object} o
 * @param {object} o.env         process.env of the workflow step
 * @param {object} o.chain       ops.chain (deploy/config/breakers.json)
 * @param {() => number} o.now
 * @param {(ms: number) => Promise<void>} o.sleep
 * @param {(c: {index:number, mode:string, env:object, timeoutMs:number}) => Promise<{ok:boolean, code?:number|null, timedOut?:boolean, error?:string}>} o.runCycle
 * @param {object|null} o.api    createGithubApi(...) or a fake; null = no GitHub (a laptop): one cycle, nothing else
 * @param {{ start: string|null, current: () => Promise<string|null> }} [o.code]  commit the run started on, and the commit production points at now
 * @param {(line: string) => void} [o.out]
 * @returns {Promise<{ exitCode: number, reason: string, cycles: object[], handoff: string, paused: boolean }>}
 */
export async function runChain({ env = process.env, chain, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), runCycle, api = null, code = null, out: rawOut = (l) => console.log(l) }) {
  const secrets = collectSecrets(env);
  const personal = personalValues(env);
  const out = (line) => rawOut(scrubPersonal(scrub(line, secrets).text, personal));
  const note = (level, msg) => out(env.GITHUB_ACTIONS ? `::${level}::${msg}` : `${level.toUpperCase()}: ${msg}`);

  const self = String(env.GITHUB_RUN_ID ?? '');
  const event = env.GITHUB_EVENT_NAME ?? '';
  const inActions = env.GITHUB_ACTIONS === 'true' && Boolean(api);
  const onDefault = !env.DEFAULT_BRANCH || !env.GITHUB_REF_NAME || env.DEFAULT_BRANCH === env.GITHUB_REF_NAME;
  const chainEnabled = chain.loopMinutes > 0 && inActions;
  if (chainEnabled && !onDefault) note('notice', `branch ${env.GITHUB_REF_NAME} is not the default branch ${env.DEFAULT_BRANCH}: one cycle, no chain`);
  const canChain = chainEnabled && onDefault;
  // schedule and smoke-test runs are chain runs; a manual run is one only when asked ("chain" input)
  const looping = canChain && (event === 'schedule' || event === 'workflow_run' || (event === 'workflow_dispatch' && truthy(env.CHAIN)));
  const plan = planChain(looping ? chain : { ...chain, loopMinutes: 0 });
  const mode = looping ? 'auto' : (env.MODE || 'watch');

  const startedAt = now();
  const cycles = [];
  let failedInARow = 0;
  let paused = truthy(env[PAUSE_VARIABLE]);
  let reason = 'single';
  let handoffNow = false;
  let noted403 = false;

  // What the API can tell us between cycles. It may only ADD a pause or a stop: a 404 for the variable can also mean "the
  // job token may not read variables", so it never lifts a pause that the run started with.
  async function stateGate() {
    const wf = await api.workflowState();
    if (wf.ok && wf.json?.state && wf.json.state !== 'active') return { stop: 'disabled', detail: wf.json.state };
    const v = await api.variable(PAUSE_VARIABLE);
    if (v.ok && truthy(v.json?.value)) paused = true;
    else if (!v.ok && v.status !== 404 && !noted403) {
      noted403 = true;
      note('notice', `cannot read the ${PAUSE_VARIABLE} variable through the API (http ${v.status || 'no answer'}): a change of the variable counts from the next run start. To stop at once, cancel this run. RUNBOOK: pause posting.`);
    }
    return { stop: null };
  }

  async function look(index) {
    if (!inActions) return { stop: null };
    const runs = await api.listRuns();
    const others = runs.ok ? otherActiveRuns(runs.json?.workflow_runs, self) : [];
    if (index === 0 && others.some((r) => r.status === 'in_progress' && Number(r.id) < Number(self))) return { stop: 'chain-running' };
    const gate = await stateGate();
    if (gate.stop) return gate;
    if (index > 0) {
      // A queued manual or smoke-test run (anything but the cron) would wait for the rest of this run: let it go first.
      const waiting = others.filter((r) => r.status !== 'in_progress' && r.event !== 'schedule');
      if (waiting.length) return { stop: 'yield', detail: waiting.map((r) => `${r.event} ${r.id}`).join(', ') };
      if (code?.start) {
        let cur = null;
        try {
          cur = await code.current();
        } catch {
          cur = null;
        }
        if (cur && cur !== code.start) return { stop: 'code-changed', detail: `${code.start.slice(0, 7)} -> ${cur.slice(0, 7)}` };
      }
    }
    return { stop: null };
  }

  for (let index = 0; index < plan.ticks.length; index++) {
    const tickAt = startedAt + plan.ticks[index];
    if (index > 0 && now() < tickAt) await sleep(tickAt - now());
    const seen = await look(index);
    if (seen.stop) {
      reason = seen.stop;
      note(seen.stop === 'chain-running' ? 'notice' : 'warning', `chain stops before cycle ${index + 1}: ${seen.stop}${seen.detail ? ` (${seen.detail})` : ''}`);
      handoffNow = seen.stop === 'code-changed';
      break;
    }
    // flags set by hand (dry run, silent, force, release_held) belong to the first cycle only
    const cycleEnv = { ...env, MODE: mode, [PAUSE_VARIABLE]: paused ? (truthy(env[PAUSE_VARIABLE]) ? env[PAUSE_VARIABLE] : '1') : '' };
    if (looping) {
      cycleEnv.OUT_DIR = `deploy/out/cycle-${index + 1}`;
      if (index > 0) for (const f of ONE_SHOT_FLAGS) cycleEnv[f] = '';
    }
    delete cycleEnv.GITHUB_TOKEN; // the job token is for the API calls of this loop; the cycle does not need it
    const title = `cycle ${index + 1} of ${plan.ticks.length} (${mode}${paused ? ', paused: posts are held' : ''})`;
    out(env.GITHUB_ACTIONS ? `::group::${title}` : title);
    let r;
    try {
      r = await runCycle({ index, mode, env: cycleEnv, timeoutMs: chain.cycleTimeoutMinutes * MIN });
    } catch (e) {
      r = { ok: false, code: null, error: e.message };
    }
    if (env.GITHUB_ACTIONS) out('::endgroup::');
    cycles.push({ index, ok: r.ok, code: r.code ?? null, timedOut: Boolean(r.timedOut), paused });
    failedInARow = r.ok ? 0 : failedInARow + 1;
    if (!r.ok) note('error', `cycle ${index + 1} failed${r.timedOut ? ` (killed after ${chain.cycleTimeoutMinutes} minutes)` : r.error ? ` (${r.error})` : ` (exit ${r.code})`}`);
    if (paused && chain.pauseStopsChain) {
      reason = 'paused';
      note('warning', `${PAUSE_VARIABLE} is set: this was the last cycle of the run, nothing is posted, no successor is started. Unpause, then restart the chain. RUNBOOK: pause posting.`);
      break;
    }
    if (looping && failedInARow >= chain.maxFailedCycles) {
      reason = 'breaker';
      note('error', `chain breaker: ${failedInARow} cycles failed in a row. No successor is started; the cron or a manual run restarts it. RUNBOOK: runner stopped.`);
      break;
    }
    reason = looping ? 'loop-end' : 'single';
  }

  // ---------- hand-over: make sure exactly one successor exists ----------
  let handoff = 'none';
  let handoffFailed = false;
  const stopped = ['paused', 'breaker', 'disabled', 'chain-running', 'yield'].includes(reason);
  if (canChain && !stopped) {
    if (looping && !handoffNow) {
      const wait = startedAt + plan.handoffAt - now();
      if (wait > 0) await sleep(wait);
    }
    // The variable may have been set, or the workflow disabled, while this run waited for the hand-over.
    const gate = await stateGate();
    const runs = await api.listRuns();
    const others = runs.ok ? otherActiveRuns(runs.json?.workflow_runs, self) : [];
    if (gate.stop || (paused && chain.pauseStopsChain && reason !== 'paused')) {
      reason = gate.stop ?? 'paused';
      handoff = 'none';
      note('warning', `no successor dispatched: ${gate.stop ? `workflow is ${gate.detail}` : `${PAUSE_VARIABLE} is set`}`);
    } else if (others.length) {
      handoff = 'queued-run-takes-over';
      note('notice', `no successor dispatched: ${others.length} run(s) of this workflow already queued (${others.slice(0, 3).map((r) => `${r.event} ${r.id}`).join(', ')}), they start when this one ends`);
    } else {
      if (!runs.ok) note('warning', `could not list the workflow runs (${runs.error}): dispatching the successor anyway`);
      const ref = env.GITHUB_REF_NAME || env.DEFAULT_BRANCH || 'main';
      let last = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        last = await api.dispatch({ ref, inputs: { chain: 'true' } });
        if (last.ok) break;
        if (attempt < 3) await sleep(attempt * 3000);
      }
      if (last.ok) {
        handoff = 'dispatched';
        note('notice', `successor dispatched on ${ref}, cycles done: ${cycles.length}`);
      } else {
        handoff = 'failed';
        handoffFailed = true;
        note('error', `could not dispatch the successor (http ${last.status || 'no answer'}: ${last.error}). The cron restarts the chain. Does the workflow have "actions: write"? RUNBOOK: the chain.`);
      }
    }
  }

  const failed = cycles.filter((c) => !c.ok).length;
  const exitCode = failed > 0 || handoffFailed || reason === 'breaker' ? 1 : 0;
  note('notice', `chain run ended: ${cycles.length} cycle(s), ${failed} failed, reason ${reason}, successor ${handoff}`);
  return { exitCode, reason, cycles, handoff, paused };
}
