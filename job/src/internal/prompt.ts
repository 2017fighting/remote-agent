import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkItemComment, WorkItemTicket, WorkItemV1 } from "@remote-agent/shared";
import type { AgentRole } from "./env.js";
import type { PreviousRound } from "./round.js";

/**
 * ConfigMap `remote-agent-prompts` keys (ADR-0004): `_common` first, then the
 * role's template, plus one system prompt per review axis. `prompts/` in this
 * repo is the verbatim source of that key surface.
 */
export const PROMPT_TEMPLATE_KEYS = [
  "_common",
  "implement-ticket",
  "implement-spec",
  "review-standards",
  "review-spec",
] as const;

export const COMMON_PROMPT_KEY = "_common";

/** The reviewer conversation's two axes: each reads its own template. */
export type ReviewAxis = "spec" | "standards";

const REVIEW_TEMPLATE_KEYS: Record<ReviewAxis, string> = {
  spec: "review-spec",
  standards: "review-standards",
};

export function roleTemplateKey(role: AgentRole): string {
  return role;
}

export function reviewTemplateKey(axis: ReviewAxis): string {
  return REVIEW_TEMPLATE_KEYS[axis];
}

export interface RenderPromptInput {
  role: AgentRole;
  workItem: WorkItemV1;
  /** Review fixed point: this run's start for the ticket role, the branch start for the spec role. */
  fixedPoint: string;
  promptsDir: string;
}

/**
 * One render, self-contained: `_common` + the role template with every
 * placeholder substituted. The result is the only prompt the run gets, so a
 * reader never has to open another file (spec #33 §7).
 */
export async function renderPrompt(input: RenderPromptInput): Promise<string> {
  const common = await readPromptFile(input.promptsDir, COMMON_PROMPT_KEY);
  const role = await readPromptFile(input.promptsDir, roleTemplateKey(input.role));
  const template = `${common.trimEnd()}\n\n${role.trimEnd()}\n`;
  return substitutePlaceholders(template, placeholderValues(input));
}

export interface RenderReviewPromptInput {
  axis: ReviewAxis;
  /** The ref the reviewer diffs against; the same literal the implementer passed to `code_review`. */
  fixedPoint: string;
  /** `owner/repo#<spec>` — the Spec axis' comparison surface, never inferred by the reviewer. */
  specRef: string;
  /** The spec body; empty only when the work item carries none (the template then says so). */
  specBody: string;
  promptsDir: string;
}

/** The axis template as the reviewer conversation's system prompt, every placeholder substituted. */
export async function renderReviewPrompt(input: RenderReviewPromptInput): Promise<string> {
  const template = await readPromptFile(input.promptsDir, reviewTemplateKey(input.axis));
  return substitutePlaceholders(template, {
    fixed_point: input.fixedPoint,
    spec_ref: input.specRef,
    spec_body: input.specBody,
  });
}

export async function readPromptFile(dir: string, key: string): Promise<string> {
  const path = join(dir, key);
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`prompt template ${key} is missing from the prompt ConfigMap at ${dir}`);
    }
    throw error;
  }
}

export function placeholderValues(input: RenderPromptInput): Record<string, string> {
  const workRef = `${input.workItem.repo}#${input.workItem.number}`;
  return {
    work_ref: workRef,
    work_title: input.workItem.title,
    work_body: workBody(input.workItem, input.role),
    ticket_number: String(input.workItem.number),
    spec_number: String(input.workItem.specNumber),
    fixed_point: input.fixedPoint,
  };
}

/**
 * The body the prompt shows.
 *
 * Every role gets its own body **and its own comments**: the body is the acceptance
 * surface, but the comments are where a human writes a correction — the one that made
 * them reopen the ticket (ADR-0017), or the one only a spec-level run can act on
 * ("don't open the PR yet", "the acceptance surface changed: drop ticket X", #65).
 *
 * The closeout role has no continuity channel besides them: its every round starts on
 * a **fresh volume** (ADR-0016), so the comments — the App's own failure comment from
 * the round before included — are the whole record of what happened.
 *
 * The spec role's ticket map comes last, after the comments: `prompts/implement-spec`
 * calls it "rendered above", so it has to arrive inside the body section — the
 * templates themselves are verbatim and never change.
 */
export function workBody(workItem: WorkItemV1, role: AgentRole): string {
  const body = withComments(workItem.body, workItem.comments);
  if (role === "implement-spec") {
    const tickets = workItem.tickets;
    return tickets === undefined ? body : `${body}\n\n${renderTicketMap(tickets)}`;
  }
  return body;
}

/**
 * The round header the runner puts in front of the prompt for round 2 and later
 * (ADR-0017): what the conversation cannot say for itself.
 *
 * The history in front of the model ends with its own last act — reporting `done`
 * or `blocked` — and the work item's comments are the human's answer to it. Without
 * a line naming the round, the cheapest thing for the model to do is report the
 * same outcome again, which is the failure ADR-0011 names ("否则 agent 可能直接再报
 * 一次 done"). Round 1 gets nothing: there is no previous round to describe.
 *
 * It is generated here rather than authored in the ConfigMap because the facts it
 * states — which round, how the last one ended, when — live on the volume, and the
 * template's key and placeholder surface stays untouched (ADR-0004, ADR-0017).
 */
export interface RoundContext {
  /** 1 for a fresh conversation; every round that reported adds one. */
  round: number;
  /**
   * How the round before this one ended, read before the reset cleared it — or
   * `null` when this pod did not see that boundary (it opened a volume whose reset
   * already landed), in which case the header says only what is still true.
   */
  previous: PreviousRound | null;
}

export function roundHeader(context: RoundContext): string {
  if (context.round <= 1) return "";
  const previous = context.previous;
  const reported =
    previous?.outcome == null
      ? "A previous round of this ticket already ran and reported its outcome"
      : `A previous round of this ticket already ran and reported **${previous.outcome}**`;
  const when = previous?.completedAt ? ` at ${previous.completedAt}` : "";
  return [
    `# Round ${context.round} of this ticket`,
    "",
    `${reported}${when}. This run is a new round on the same conversation, not a continuation of that ` +
      "report: the work item's comments are what happened since, so re-read them and continue the work — do " +
      "not simply re-report the outcome.",
  ].join("\n");
}

/**
 * A work item's comments under the body, oldest first, in the same format the ticket
 * map uses for a sub-issue's comments — one reader learns one shape. A work item with
 * no comments gets no empty heading.
 */
function withComments(body: string, comments: WorkItemComment[]): string {
  if (comments.length === 0) return body;
  const lines = [body.trimEnd(), "", "## Comments", ""];
  for (const comment of comments) lines.push(...commentLines(comment));
  return lines.join("\n").trimEnd();
}

/**
 * The spec role's ticket map: every sub-issue in the spec's listed order
 * (newest last), with its body and its comments in chronological order — the
 * acceptance surface of the closeout run.
 */
export function renderTicketMap(tickets: WorkItemTicket[]): string {
  if (tickets.length === 0) return "## Ticket map\n\n_This spec has no sub-issues._";
  const lines = ["## Ticket map", ""];
  for (const ticket of tickets) {
    lines.push(`### #${ticket.number} — ${ticket.title}`, "", ticket.body.trimEnd(), "");
    if (ticket.comments.length > 0) {
      lines.push("#### Comments", "");
      for (const comment of ticket.comments) lines.push(...commentLines(comment));
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}

function commentLines(comment: WorkItemComment): string[] {
  const who = comment.author === "" ? "unknown" : comment.author;
  const when = comment.createdAt === "" ? "" : ` (${comment.createdAt})`;
  return [`**${who}**${when}:`, "", comment.body.trimEnd(), ""];
}

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Replace every `{{name}}`; an unknown name is a template bug, so it throws instead of shipping a literal. */
export function substitutePlaceholders(template: string, values: Record<string, string>): string {
  const unknown = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      unknown.add(name);
      return "";
    }
    return value;
  });
  if (unknown.size > 0) throw new Error(`prompt template has unknown placeholders: ${[...unknown].join(", ")}`);
  if (/\{\{\s*[a-z_]+\s*\}\}/.test(rendered)) throw new Error("prompt template still has placeholders after rendering");
  return rendered;
}
