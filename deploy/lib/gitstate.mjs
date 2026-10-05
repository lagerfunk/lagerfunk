// State lives on an orphan branch ("state") of the runner repo: one commit, force-pushed every run, so the repository
// does not grow. Files: state.json (the Store), state.prev.json (one run back, for a manual rollback),
// activity.jsonl and status.json (read by the dashboard).
// Uses plumbing commands only (hash-object, mktree, commit-tree, push), so the working tree is never touched.
// Credentials come from the checkout step (actions/checkout leaves the job token in the git config).
import { spawn } from 'node:child_process';

export const STATE_BRANCH = 'state';
export const STATE_FILES = ['state.json', 'state.prev.json', 'activity.jsonl', 'status.json'];

/** git runner: (args, { input, env }) -> stdout. Rejects with stderr on a non-zero exit. */
export function createGit({ cwd = process.cwd(), env = process.env } = {}) {
  return (args, { input = null, env: extra = {} } = {}) =>
    new Promise((resolve, reject) => {
      const p = spawn('git', args, { cwd, env: { ...env, ...extra, GIT_TERMINAL_PROMPT: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(out) : reject(Object.assign(new Error(`git ${args[0]} failed (${code}): ${err.trim().slice(0, 300)}`), { code, stderr: err }))));
      p.stdin.on('error', () => {}); // git may exit before reading its input (EPIPE); the exit code below reports why
      p.stdin.end(input ?? '');
    });
}

/** Read the state branch. status: "ok" | "missing" (no such branch yet). Other failures throw. */
export async function fetchState({ git, remote = 'origin', branch = STATE_BRANCH, files = STATE_FILES } = {}) {
  const ref = `refs/remotes/${remote}/${branch}`;
  try {
    await git(['fetch', '--no-tags', '--depth=1', '--force', remote, `+refs/heads/${branch}:${ref}`]);
  } catch (e) {
    if (/couldn't find remote ref|could not find remote ref|no such ref/i.test(e.stderr ?? e.message)) return { status: 'missing', sha: null, files: {} };
    throw e;
  }
  const sha = (await git(['rev-parse', ref])).trim();
  const out = {};
  for (const f of files) {
    try {
      out[f] = await git(['show', `${ref}:${f}`]);
    } catch {
      out[f] = null;
    }
  }
  return { status: 'ok', sha, files: out };
}

const retryable = (e) => !/stale info|rejected|non-fast-forward|protected branch|Permission to .* denied|403|401/i.test(`${e.stderr ?? ''} ${e.message}`);

/**
 * Replace the state branch with one commit holding `files` ({ name: text }). Refuses to overwrite a branch that
 * somebody else changed since we read it (force-with-lease on the sha we fetched).
 */
export async function pushState({ git, files, expectSha = null, message = 'state', remote = 'origin', branch = STATE_BRANCH, author = { name: 'lagerfunk-runner', email: 'runner@users.noreply.github.com' }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 4 } = {}) {
  const entries = [];
  for (const [name, text] of Object.entries(files)) {
    if (text === null || text === undefined) continue;
    const sha = (await git(['hash-object', '-w', '--stdin'], { input: text })).trim();
    entries.push(`100644 blob ${sha}\t${name}\n`);
  }
  const tree = (await git(['mktree'], { input: entries.join('') })).trim();
  const who = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
  const commit = (await git(['commit-tree', tree, '-m', message], { env: who })).trim();
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await git(['push', '--quiet', remote, `${commit}:refs/heads/${branch}`, `--force-with-lease=refs/heads/${branch}:${expectSha ?? ''}`]);
      return { sha: commit, attempts: i };
    } catch (e) {
      lastErr = e;
      if (!retryable(e) || i === attempts) break;
      await sleep(2000 * 2 ** (i - 1));
    }
  }
  throw Object.assign(new Error(`state push failed: ${lastErr.message}`), { cause: lastErr });
}
