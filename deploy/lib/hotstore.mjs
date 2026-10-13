// The drop log of the hot watcher, kept as drops.json on the branch 'drops' of this repository.
//
// One commit, force-pushed: the branch never grows, and only one hot run writes at a time (concurrency group "hot").
// Written with git plumbing (hash-object, mktree, commit-tree) so the checkout the watcher runs from is never touched.
// Public data only: shop, card, price, times. No keys, no personal data.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const DROPS_BRANCH = 'drops';
export const DROPS_FILE = 'drops.json';

export function createHotStore({ cwd, env = process.env, remote = 'origin', branch = DROPS_BRANCH, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const genv = { ...env, GIT_AUTHOR_NAME: 'lagerfunk-hot', GIT_AUTHOR_EMAIL: 'runner@users.noreply.github.com', GIT_COMMITTER_NAME: 'lagerfunk-hot', GIT_COMMITTER_EMAIL: 'runner@users.noreply.github.com' };
  const git = async (args, input) => {
    if (input !== undefined) {
      return new Promise((resolve, reject) => {
        const child = execFile('git', args, { cwd, env: genv, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
        child.stdin.end(input);
      });
    }
    const { stdout } = await run('git', args, { cwd, env: genv, maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  };

  /** The saved log, or null when the branch does not exist yet. Throws only on unreadable JSON. */
  async function load() {
    try {
      await git(['fetch', '--quiet', '--no-tags', '--depth=1', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
    } catch {
      return null; // no branch yet
    }
    const text = await git(['show', `refs/remotes/${remote}/${branch}:${DROPS_FILE}`]);
    return JSON.parse(text);
  }

  /** Save the log as the single commit of the branch. Retries for about a minute. */
  async function save(db) {
    const body = `${JSON.stringify(db, null, 1)}\n`;
    let lastErr = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const blob = await git(['hash-object', '-w', '--stdin'], body);
        const tree = await git(['mktree'], `100644 blob ${blob}\t${DROPS_FILE}\n`);
        const commit = await git(['commit-tree', tree, '-m', `drops ${db.savedAt ?? new Date().toISOString()}`]);
        await git(['push', '--quiet', '--force', remote, `${commit}:refs/heads/${branch}`]);
        return { ok: true, commit };
      } catch (e) {
        lastErr = e;
        await sleep(2000 * 2 ** attempt);
      }
    }
    return { ok: false, error: String(lastErr?.message ?? lastErr).slice(0, 200) };
  }

  return { load, save };
}
