// The "ops" branch of the runner repository: the watchdog's memory (watchdog.json) and the daily state backups
// (backups/YYYY-MM-DD/...). One parentless commit, replaced on every write like the state branch, so it never grows.
// Written only by the watchdog and the ops workflow (both in the concurrency group lagerfunk-ops), read by anyone.
//
// Plumbing only (read-tree into a temporary index, update-index, write-tree, commit-tree, push with a lease): the
// working tree is never touched and nested paths work.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const OPS_BRANCH = 'ops';

const missing = (e) => /couldn't find remote ref|could not find remote ref|no such ref/i.test(`${e.stderr ?? ''} ${e.message}`);

/**
 * Fetch a branch. Returns { status: 'ok'|'missing', sha, ref, paths, read(path) }.
 */
export async function readBranch({ git, branch = OPS_BRANCH, remote = 'origin' } = {}) {
  const ref = `refs/remotes/${remote}/${branch}`;
  try {
    await git(['fetch', '--no-tags', '--depth=1', '--force', remote, `+refs/heads/${branch}:${ref}`]);
  } catch (e) {
    if (missing(e)) return { status: 'missing', sha: null, ref: null, paths: [], read: async () => null };
    throw e;
  }
  const sha = (await git(['rev-parse', ref])).trim();
  const paths = (await git(['ls-tree', '-r', '--name-only', ref])).split('\n').filter(Boolean);
  const read = async (p) => {
    if (!paths.includes(p)) return null;
    try {
      return await git(['show', `${ref}:${p}`]);
    } catch {
      return null;
    }
  };
  return { status: 'ok', sha, ref, paths, read };
}

const retryable = (e) => !/stale info|rejected|non-fast-forward|protected branch|Permission to .* denied|403|401/i.test(`${e.stderr ?? ''} ${e.message}`);

/**
 * Replace the branch with one commit: the tree of `base` (a ref or null) plus `set` ({ path: text }) minus `remove`
 * (paths). Refuses to overwrite a branch someone changed since it was read (lease on expectSha).
 */
export async function writeBranch({ git, branch = OPS_BRANCH, base = null, set = {}, remove = [], expectSha = null, message = 'ops', remote = 'origin', author = { name: 'lagerfunk-watchdog', email: 'runner@users.noreply.github.com' }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 3 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lagerfunk-index-'));
  const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    if (base) await git(['read-tree', base], { env });
    else await git(['read-tree', '--empty'], { env });
    for (const p of remove) await git(['update-index', '--force-remove', '--', p], { env });
    for (const [p, text] of Object.entries(set)) {
      if (text === null || text === undefined) {
        await git(['update-index', '--force-remove', '--', p], { env });
        continue;
      }
      const sha = (await git(['hash-object', '-w', '--stdin'], { input: text })).trim();
      await git(['update-index', '--add', '--cacheinfo', `100644,${sha},${p}`], { env });
    }
    const tree = (await git(['write-tree'], { env })).trim();
    const who = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
    const commit = (await git(['commit-tree', tree, '-m', message], { env: who })).trim();
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        await git(['push', '--quiet', remote, `${commit}:refs/heads/${branch}`, `--force-with-lease=refs/heads/${branch}:${expectSha ?? ''}`]);
        return { sha: commit, tree, attempts: i };
      } catch (e) {
        lastErr = e;
        if (!retryable(e) || i === attempts) break;
        await sleep(2000 * 2 ** (i - 1));
      }
    }
    throw Object.assign(new Error(`${branch} push failed: ${lastErr.message}`), { cause: lastErr });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
