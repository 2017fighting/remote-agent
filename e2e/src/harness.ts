import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Process helpers for the kind harness.
 *
 * Every cluster interaction is a `kind` / `kubectl` / `docker` / `git` call, and
 * every one of them echoes into a sectioned log. The segmentation is the point
 * (ticket #41 AC 7): when the e2e fails, the log says whether it failed in the
 * cluster bring-up, the image build, the stub, the App or the Job, instead of
 * producing one undifferentiated wall.
 */

const exec = promisify(execFile);

/** The sections a run's log is divided into, in order. */
export const SECTIONS = ["cluster", "images", "stubs", "app", "job", "assert"] as const;
export type Section = (typeof SECTIONS)[number];

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  /** Run a command and throw on a nonzero exit, echoing it into the section log. */
  run(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean }): Promise<CommandResult>;
  /** A line of narration in the section log (not a command). */
  note(message: string): void;
  /** Raw text, already formatted (e.g. a manifest being applied). */
  write(text: string): void;
  section(name: Section, title: string): void;
  /** The whole log so far, for the failure dump. */
  text(): string;
}

export function createRunner(options?: { verbose?: boolean; log?: (line: string) => void }): Runner {
  const lines: string[] = [];
  const emit = options?.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const append = (line: string): void => {
    lines.push(line);
    emit(line);
  };

  return {
    async run(command, args, runOptions) {
      const printable = `${command} ${args.map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg)).join(" ")}`;
      append(`$ ${printable}`);
      try {
        const { stdout, stderr } = await exec(command, args, {
          cwd: runOptions?.cwd,
          env: runOptions?.env ?? process.env,
          maxBuffer: 64 * 1024 * 1024,
        });
        if (options?.verbose === true && stdout.trim() !== "") append(indent(stdout.trimEnd()));
        return { command: printable, exitCode: 0, stdout, stderr };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        const result: CommandResult = {
          command: printable,
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
        };
        if (result.stdout.trim() !== "") append(indent(result.stdout.trimEnd()));
        if (result.stderr.trim() !== "") append(indent(result.stderr.trimEnd()));
        if (runOptions?.allowFailure !== true) {
          throw new Error(`command failed (${result.exitCode}): ${printable}\n${result.stderr.trim()}`);
        }
        return result;
      }
    },
    note(message) {
      append(`# ${message}`);
    },
    write(text) {
      append(text);
    },
    section(name, title) {
      append("");
      append(`${"=".repeat(78)}`);
      append(`== [${name}] ${title}`);
      append(`${"=".repeat(78)}`);
    },
    text() {
      return lines.join("\n");
    },
  };
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

/** A throwaway directory the harness owns; removed unless `--keep`. */
export async function workDir(keep: boolean): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "remote-agent-e2e-"));
  return {
    path,
    cleanup: async () => {
      if (!keep) await rm(path, { recursive: true, force: true });
    },
  };
}

/**
 * Write a real bare repository the stub serves, with `main` and the spec branch.
 *
 * This is what makes the git half of the scenario real: Seed clones from here,
 * the runner's `merge-base origin/main HEAD` runs against these refs, and the
 * final push lands in this repository — all through `git http-backend`, not
 * through objects pretending to be git.
 */
export async function seedBareRepository(input: {
  projectRoot: string;
  repo: string;
  specNumber: number;
  runner: Runner;
}): Promise<void> {
  const [owner, name] = input.repo.split("/");
  if (owner === undefined || name === undefined) throw new Error(`repo ${input.repo} is not owner/name`);
  const bare = join(input.projectRoot, owner, `${name}.git`);
  const work = join(input.projectRoot, "_seed-work");
  await mkdir(join(input.projectRoot, owner), { recursive: true });

  const git = (args: string[], cwd: string): Promise<CommandResult> =>
    input.runner.run("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "remote-agent-e2e",
        GIT_AUTHOR_EMAIL: "remote-agent-e2e@example.invalid",
        GIT_COMMITTER_NAME: "remote-agent-e2e",
        GIT_COMMITTER_EMAIL: "remote-agent-e2e@example.invalid",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });

  await input.runner.run("git", ["init", "--bare", "--initial-branch=main", bare], { cwd: input.projectRoot });
  await mkdir(work, { recursive: true });
  await git(["init", "--initial-branch=main", work], work);
  await writeFile(join(work, "README.md"), "# e2e target repository\n\nSeeded by the kind harness.\n");
  await writeFile(
    join(work, "package.json"),
    JSON.stringify({ name: "e2e-target", private: true, scripts: { test: "true" } }, null, 2) + "\n",
  );
  await git(["add", "-A"], work);
  await git(["commit", "-m", "initial commit"], work);
  await git(["remote", "add", "origin", bare], work);
  await git(["push", "origin", "main"], work);
  // The spec branch the Job seeds from and pushes to (spec #33 §6).
  await git(["push", "origin", `main:refs/heads/agent/spec-${input.specNumber}`], work);
  await rm(work, { recursive: true, force: true });
}

/** A base64 manifest apply, so multi-document YAML never has to be quoted. */
export async function applyManifests(runner: Runner, context: string, documents: Record<string, unknown>[]): Promise<void> {
  for (const document of documents) {
    const path = join(tmpdir(), `ra-e2e-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(path, JSON.stringify(document));
    try {
      await runner.run("kubectl", ["--context", context, "apply", "-f", path]);
    } finally {
      await rm(path, { force: true });
    }
  }
}

export interface DumpOptions {
  context: string;
  namespace: string;
  runner: Runner;
  /** Pod label selector for the Job pods (`job-name` is set by k8s). */
  tailLines?: number;
}

/**
 * Everything a failed run needs: App logs, Job/pod describe, and the last N
 * lines of every container. Bounded and sectioned, so a failure dump is
 * attributable rather than enormous (ticket #41 AC 7).
 */
export async function dumpDiagnostics(options: DumpOptions): Promise<string> {
  const { context, namespace, runner } = options;
  const tail = options.tailLines ?? 120;
  const parts: string[] = [];

  const capture = async (title: string, args: string[]): Promise<void> => {
    parts.push(`\n----- ${title} -----`);
    const result = await runner.run("kubectl", args, { allowFailure: true });
    parts.push(result.stdout.trim() === "" ? "(no output)" : result.stdout.trimEnd());
    if (result.stderr.trim() !== "") parts.push(`(stderr) ${result.stderr.trimEnd()}`);
  };

  const kubectl = (args: string[]): string[] => ["--context", context, ...args];

  await capture("jobs", kubectl(["-n", namespace, "get", "jobs", "-o", "wide"]));
  await capture("pods", kubectl(["-n", namespace, "get", "pods", "-o", "wide"]));
  await capture("pvcs", kubectl(["-n", namespace, "get", "pvc", "-o", "wide"]));
  await capture("secrets", kubectl(["-n", namespace, "get", "secrets"]));
  await capture("app deployment describe", kubectl(["-n", namespace, "describe", "deployment", "remote-agent"]));
  await capture("app logs", kubectl(["-n", namespace, "logs", "deploy/remote-agent", "--tail", String(tail)]));
  await capture("job describe", kubectl(["-n", namespace, "describe", "jobs"]));
  await capture("stub-github logs", kubectl(["-n", namespace, "logs", "deploy/stub-github", "--tail", String(tail)]));
  await capture("stub-model logs", kubectl(["-n", namespace, "logs", "deploy/stub-model", "--tail", String(tail)]));

  // Every container of every pod that belongs to a Job: the Job's own evidence.
  const pods = await runner.run(
    "kubectl",
    kubectl(["-n", namespace, "get", "pods", "-o", "jsonpath={.items[*].metadata.name}"]),
    { allowFailure: true },
  );
  for (const pod of pods.stdout.trim().split(/\s+/).filter((name) => name !== "")) {
    for (const container of ["seed", "runner"]) {
      await capture(
        `pod ${pod} container ${container}`,
        kubectl(["-n", namespace, "logs", pod, "-c", container, "--tail", String(tail)]),
      );
    }
    await capture(`pod ${pod} describe`, kubectl(["-n", namespace, "describe", "pod", pod]));
  }

  return parts.join("\n");
}
