import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Models,
} from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { reviewerExtension } from "../../src/internal/reviewer-tools.js";
import { buildRegistry, type RunDeps } from "../../src/internal/runner.js";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { RunResultV1, WorkItemV1 } from "@remote-agent/shared";
import { jobPaths, type JobPaths, type RunnerEnv } from "../../src/internal/env.js";

const exec = promisify(execFile);

export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: cwd,
    },
  });
  return stdout.trim();
}

export const WORK_ITEM: WorkItemV1 = {
  v: 1,
  repo: "2017fighting/remote-agent",
  number: 39,
  specNumber: 33,
  title: "Job image: seed + runner",
  body: "Seed the volume, run one role, push, annotate.",
  comments: [{ author: "maintainer", body: "go", createdAt: "2026-01-01T00:00:00.000Z" }],
};

export interface RunnerFixture {
  root: string;
  /** Bare remote the runner pushes to, and the worktree it pushes from. */
  remote: string;
  worktree: string;
  paths: JobPaths;
  env: RunnerEnv;
  models: Models;
  /** Scripted model responses; empty means any model request fails the test. */
  script(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]): void;
  pendingResponses(): number;
  /** The standards files the runner scans for the Standards axis (the fixture's repo has none). */
  standardsFiles?(): Promise<string[]>;
}

/**
 * A volume-shaped tree (repo/state/home) with a real worktree, a real bare
 * remote, a prompt ConfigMap and a mounted token file. No network anywhere.
 */
export async function runnerFixture(): Promise<RunnerFixture> {
  const root = await mkdtemp(join(tmpdir(), "remote-agent-runner-"));
  const remote = join(root, "origin.git");
  const worktree = join(root, "volume", "repo");
  await mkdir(remote, { recursive: true });
  await git(["init", "--bare", "--initial-branch=main", remote], root);
  await mkdir(worktree, { recursive: true });
  await git(["init", "--initial-branch=agent/spec-33", worktree], root);
  await writeFile(join(worktree, "README.md"), "worktree\n");
  await git(["add", "-A"], worktree);
  await git(["commit", "-m", "init"], worktree);
  await git(["remote", "add", "origin", remote], worktree);
  await git(["push", "origin", "agent/spec-33"], worktree);
  await git(["checkout", "-b", "main"], worktree);
  await git(["push", "origin", "main"], worktree);
  await git(["checkout", "agent/spec-33"], worktree);

  const volume = join(root, "volume");
  const paths = jobPaths({
    repo: worktree,
    state: join(volume, "state"),
    home: join(volume, "home"),
    seedMarker: join(volume, "state", "seeded.json"),
    seedError: join(volume, "state", "seed-error.json"),
    sessionDatabase: join(volume, "state", "session.sqlite"),
    prompts: join(root, "prompts"),
    token: join(root, "token"),
  });
  await mkdir(paths.state, { recursive: true });
  await mkdir(paths.home, { recursive: true });
  await mkdir(paths.prompts, { recursive: true });
  await writeFile(paths.token, "ghs_test_token\n");
  await writeFile(
    join(paths.prompts, "_common"),
    [
      "# Who you are",
      "You are an unattended agent working on {{work_ref}}.",
      "Title: {{work_title}}",
      "Body:",
      "{{work_body}}",
      "Fixed point: {{fixed_point}}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(paths.prompts, "implement-spec"),
    ["# Role: implement-spec", "This run closes out spec #{{spec_number}} from {{fixed_point}}.", ""].join("\n"),
  );
  await writeFile(
    join(paths.prompts, "implement-ticket"),
    ["# Role: implement-ticket", "This run implements ticket #{{ticket_number}} of spec #{{spec_number}}.", ""].join("\n"),
  );
  await writeFile(
    join(paths.prompts, "review-spec"),
    [
      "# Spec axis",
      "Fixed point {{fixed_point}}; spec {{spec_ref}}:",
      "{{spec_body}}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(paths.prompts, "review-standards"),
    ["# Standards axis", "Fixed point {{fixed_point}}.", ""].join("\n"),
  );

  const faux = fauxProvider({
    provider: "omniroute",
    models: [{ id: "default", reasoning: true }, { id: "review", reasoning: true }],
  });
  const models = createModels();
  models.setProvider(faux.provider);

  const env: RunnerEnv = {
    repo: WORK_ITEM.repo,
    specNumber: 33,
    branch: "agent/spec-33",
    remoteUrl: remote,
    commitEmail: "5390512+remote-agent[bot]@users.noreply.github.com",
    role: "implement-ticket",
    thinkingLevel: "high",
    workItem: WORK_ITEM,
    omniRoute: { baseUrl: "http://omniroute.test/v1", model: "default", reviewModel: "review", apiKey: "test" },
    jobName: "agent-2017fighting-remote-agent-39",
    jobNamespace: "remote-agent",
  };

  return {
    root,
    remote,
    worktree,
    paths,
    env,
    models,
    script: (responses) => faux.setResponses(responses),
    pendingResponses: () => faux.getPendingResponseCount(),
  };
}

export async function cleanup(fixture: RunnerFixture | undefined): Promise<void> {
  if (fixture) await rm(fixture.root, { recursive: true, force: true });
}

/** Everything the runner does to the outside world, in order. */
export interface Recorded {
  events: string[];
  results: unknown[];
}

/**
 * The run's dependencies with a fixture's real pieces, plus a recorder for the two
 * things the runner does to the outside world — a push that really lands on the
 * fixture's bare remote, and the annotation — and `noOwnRunResult` as the default
 * own-Job answer (the shape of a Job that was created fresh).
 */
export function depsFor(f: RunnerFixture, recorded: Recorded, overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    env: f.env,
    paths: f.paths,
    models: f.models,
    log: () => {},
    openStorage: openStorageFor(),
    annotate: async (result: RunResultV1) => {
      recorded.events.push("annotate");
      recorded.results.push(result);
    },
    push: async () => {
      recorded.events.push("push");
      await git(["push", "origin", `HEAD:refs/heads/${f.env.branch}`], f.worktree);
      return { kind: "pushed" } as const;
    },
    hasOwnRunResult: noOwnRunResult,
    ...overrides,
  };
}

export function openStorageFor(): (path: string) => Promise<Awaited<ReturnType<typeof openNodeSqliteStorage>>> {
  return (path: string) => openNodeSqliteStorage(path);
}

/**
 * The shared default for `RunDeps.hasOwnRunResult`: this run's own Job carries no
 * run-result annotation, which is the shape of a Job that was created fresh. Only
 * the already-complete branch reads it (ADR-0016), so tests that never reach that
 * branch can leave it here.
 */
export const noOwnRunResult = async (): Promise<boolean> => false;

export function finishTicketCall(summary = "did the thing"): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall("finish_ticket", { summary }, { id: "call-finish" })], {
    stopReason: "toolUse",
  });
}

export function finishSpecCall(
  args: { summary?: string; prBody?: string; commentBody?: string; newTickets?: { title: string; body: string; readyForAgent: boolean }[]; warnings?: string[] } = {},
): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage(
    [fauxToolCall("finish_spec", { summary: "closed the spec", prBody: "## Summary\nshape", ...args }, { id: "call-spec" })],
    { stopReason: "toolUse" },
  );
}

export function blockedCall(args: Record<string, unknown> = {}): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall("blocked", { summary: "stuck", commentBody: "change X", ...args }, { id: "call-blocked" })], {
    stopReason: "toolUse",
  });
}

/** One reviewer conversation's answer (the reviewer's whole report). */
export function reviewerReport(text: string): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxText(text)]);
}

export function codeReviewCall(fixedPoint: string, id = "call-review"): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage([fauxToolCall("code_review", { fixedPoint }, { id })], { stopReason: "toolUse" });
}

/** One reviewer conversation, read back the way the runner created it. */
export interface ReviewerConversation {
  id: number;
  /** The tool names the conversation's agent offers, in registry order. */
  tools: string[];
  /** The first message the reviewer received: its rendered axis template. */
  firstMessage: string;
}

/** Every non-root conversation on the volume, with the tool table its agent resolves. */
export async function reviewerConversations(
  fixture: RunnerFixture,
  env: RunnerEnv = fixture.env,
): Promise<ReviewerConversation[]> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(fixture.paths.sessionDatabase),
    { models: fixture.models, registry: runRegistry(fixture, env) },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const page = await harness.commit((tx) => tx.scanConversations({}, 100), BACKGROUND_CONTEXT);
    const others = page.items.filter((record) => record.id !== root.id);
    const found: ReviewerConversation[] = [];
    for (const record of others) {
      const conversation = await harness.conversation(record.id, BACKGROUND_CONTEXT);
      if (conversation === undefined) continue;
      const agent = await conversation.agent(BACKGROUND_CONTEXT);
      const entries = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      const user = entries.items.find((entry) => entry.kind === "pi.user");
      found.push({
        id: record.id,
        tools: agent.tools.map((tool) => tool.name),
        firstMessage: messageText(user?.model?.[0]),
      });
    }
    return found;
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

/**
 * The registry one run installs, so a stored `extensions` filter resolves to the
 * tool table the conversation really had. The harness handle is absent here: no
 * tool runs in these read-backs.
 */
function runRegistry(fixture: RunnerFixture, env: RunnerEnv = fixture.env) {
  return buildRegistry(
    {
      env,
      paths: fixture.paths,
      log: () => {},
      ...(fixture.standardsFiles === undefined ? {} : { standardsFiles: fixture.standardsFiles }),
    },
    [],
  );
}

function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((block) => (typeof block === "object" && block !== null && (block as { type?: string }).type === "text"
        ? [(block as { text: string }).text]
        : []))
      .join("\n");
  }
  return "";
}

/** The implementer's tool table: the root conversation's agent, read after the run. */
export async function implementerTools(fixture: RunnerFixture, env: RunnerEnv = fixture.env): Promise<string[]> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(fixture.paths.sessionDatabase),
    { models: fixture.models, registry: runRegistry(fixture, env) },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const agent = await root.agent(BACKGROUND_CONTEXT);
    return agent.tools.map((tool) => tool.name);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

/** One tool result from the implementer's transcript: the call's id and its error code, if any. */
export interface ToolResultRecord {
  callId: string;
  isError: boolean;
  code?: string;
  text: string;
}

/**
 * Every user entry the volume carries, oldest first: one rendered prompt per round,
 * then a conflict turn's. The only prompt the model ever sees.
 */
export async function submittedPrompts(fixture: RunnerFixture): Promise<string[]> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(fixture.paths.sessionDatabase),
    { models: fixture.models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const page = await root.entries({}, 200, undefined, BACKGROUND_CONTEXT);
    return page.items
      .flatMap((entry) => {
        if (entry.kind !== "pi.user") return [];
        const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
        return [typeof content === "string" ? content : JSON.stringify(content)];
      })
      .reverse();
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

/** The first prompt on the conversation: round 1's. */
export async function submittedPrompt(fixture: RunnerFixture): Promise<string> {
  return (await submittedPrompts(fixture))[0] ?? "";
}

/** Every tool result the implementer's transcript holds, oldest first. */
export async function toolResults(fixture: RunnerFixture): Promise<ToolResultRecord[]> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(fixture.paths.sessionDatabase),
    { models: fixture.models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const page = await root.entries({}, 200, undefined, BACKGROUND_CONTEXT);
    return page.items.flatMap((entry) => {
      if (entry.kind !== "pi.tool-result") return [];
      const message = entry.model?.[0] as { toolCallId?: string; isError?: boolean; content?: unknown } | undefined;
      const diagnostics = (entry.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics ?? [];
      return [
        {
          callId: message?.toolCallId ?? "",
          isError: message?.isError === true,
          ...(diagnostics[0]?.code === undefined ? {} : { code: diagnostics[0].code }),
          text: messageText(message),
        },
      ];
    });
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

export { fauxAssistantMessage, fauxToolCall };
