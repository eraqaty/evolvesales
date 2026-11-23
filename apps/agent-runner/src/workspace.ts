import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from './emit.js';

const run = promisify(execFile);

export const REPO_DIR = '/workspace/repo';
const TOKEN_FILE = '/home/agent/.git-token';

/** Hardened git: no hooks, no local-file transport, no submodules, no prompts, no redirects. */
const GIT_SAFETY = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'submodule.recurse=false',
  '-c',
  'http.followRedirects=false',
  '-c',
  'advice.detachedHead=false',
];

/** Reads the token from a tmpfs file only when git asks; it never appears in argv or env. */
const CREDENTIAL_HELPER = `!f() { test "$1" = get || exit 0; echo username=x-access-token; printf 'password=%s\\n' "$(cat ${TOKEN_FILE})"; }; f`;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run('git', [...GIT_SAFETY, ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/false',
      HOME: '/home/agent',
    },
    maxBuffer: 10 * 1024 * 1024,
    timeout: 5 * 60_000,
  });
  return stdout.trim();
}

/**
 * Fetches exactly `sha` (depth 1) into REPO_DIR, verifies HEAD, then:
 * deletes the token, removes `.git` and every symlink, and makes the tree read-only.
 * Returns the checked-out SHA.
 */
export async function prepareWorkspace(
  cloneUrl: string,
  sha: string,
  token: string,
): Promise<string> {
  await mkdir(REPO_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, token, { mode: 0o600 });
  try {
    await git(['init', '-q'], REPO_DIR);
    await git(['remote', 'add', 'origin', cloneUrl], REPO_DIR);
    log(`fetching ${sha}`);
    await git(
      [
        '-c',
        `credential.helper=`,
        '-c',
        `credential.helper=${CREDENTIAL_HELPER}`,
        'fetch',
        '-q',
        '--depth',
        '1',
        '--no-tags',
        'origin',
        sha,
      ],
      REPO_DIR,
    );
    await git(['checkout', '-q', '--detach', 'FETCH_HEAD'], REPO_DIR);
  } finally {
    await rm(TOKEN_FILE, { force: true });
  }

  const head = await git(['rev-parse', 'HEAD'], REPO_DIR);
  if (head !== sha) throw new Error(`checked out ${head}, expected ${sha}`);

  await rm(path.join(REPO_DIR, '.git'), { recursive: true, force: true });
  const { files, symlinks } = await lockDown(REPO_DIR);
  log(
    `workspace ready: ${files} files at ${sha}, read-only${symlinks ? `, ${symlinks} symlink(s) removed` : ''}`,
  );
  return head;
}

/** Removes symlinks (they could point outside the repo) and every write bit. */
async function lockDown(dir: string): Promise<{ files: number; symlinks: number }> {
  let files = 0;
  let symlinks = 0;
  for (const entry of await readdir(dir)) {
    const p = path.join(dir, entry);
    const st = await lstat(p);
    if (st.isSymbolicLink()) {
      await unlink(p);
      symlinks += 1;
    } else if (st.isDirectory()) {
      const sub = await lockDown(p);
      files += sub.files;
      symlinks += sub.symlinks;
      await chmod(p, 0o555);
    } else {
      files += 1;
      await chmod(p, 0o444);
    }
  }
  await chmod(dir, 0o555);
  return { files, symlinks };
}
