import { execFile } from "node:child_process";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  cwd: string;
  /** Mounted Secret file holding the installation token; read by the credential helper at each operation. */
  tokenPath: string;
  /** Commit identity for `git commit`. */
  identity?: { name: string; email: string };
}

/**
 * A git credential helper that reads the mounted token file at each operation
 * (ADR-0009). The token never enters `.git/config` or a remote URL, so it can be
 * renewed in place while the pod runs and a 520-char token never rides a URL.
 */
export function credentialHelper(tokenPath: string): string {
  return `!f() { echo username=x-access-token; echo "password=$(cat ${shellQuote(tokenPath)})"; }; f`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run git without a shell; never prompt on a terminal, never persist credentials.
 *
 * The config surface is closed on purpose: no system config, no global config, and
 * only the `-c` flags this call passes. Everything the runner needs it states
 * itself, so a `~/.gitconfig` in the image can never change what the runner does —
 * `rebase.autoStash` is the one that bit us: with it on, a dirty worktree makes
 * `git rebase` autostash and succeed, with it off the same rebase refuses to start
 * (`error: cannot rebase: You have unstaged changes`). A run whose behaviour
 * depends on the image's global config is not reproducible.
 */
export async function runGit(args: readonly string[], options: GitOptions): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  if (options.identity) {
    env["GIT_AUTHOR_NAME"] = options.identity.name;
    env["GIT_AUTHOR_EMAIL"] = options.identity.email;
    env["GIT_COMMITTER_NAME"] = options.identity.name;
    env["GIT_COMMITTER_EMAIL"] = options.identity.email;
  }
  const full = [
    // Reset any inherited helper first: only the mounted Secret may answer, and nothing is persisted.
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${credentialHelper(options.tokenPath)}`,
    ...args,
  ];
  return new Promise<GitResult>((resolve) => {
    execFile("git", full, { cwd: options.cwd, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
      resolve({ exitCode: typeof exitCode === "number" ? exitCode : 1, stdout, stderr });
    });
  });
}

/** Run git and throw on a nonzero exit, keeping stderr in the message for the seed classification. */
export async function gitOrThrow(args: readonly string[], options: GitOptions): Promise<GitResult> {
  const result = await runGit(args, options);
  if (result.exitCode !== 0) {
    throw new GitFailure(args, result);
  }
  return result;
}

export class GitFailure extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export async function revParseHead(repo: string): Promise<string> {
  const result = await runGit(["rev-parse", "HEAD"], { cwd: repo, tokenPath: "/dev/null" });
  if (result.exitCode !== 0) throw new Error(`git rev-parse HEAD failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** `git merge-base origin/main HEAD` — the spec role's review fixed point (ADR-0009). */
export async function mergeBase(repo: string, base: string, head: string): Promise<string> {
  const result = await runGit(["merge-base", base, head], { cwd: repo, tokenPath: "/dev/null" });
  if (result.exitCode !== 0) throw new Error(`git merge-base ${base} ${head} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
