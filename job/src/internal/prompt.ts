import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkItemV1 } from "@remote-agent/shared";
import type { AgentRole } from "./env.js";

/** ConfigMap `remote-agent-prompts` keys (ADR-0004): `_common` first, then the role's template. */
export const COMMON_PROMPT_KEY = "_common";

export function roleTemplateKey(role: AgentRole): string {
  return role;
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

async function readPromptFile(dir: string, key: string): Promise<string> {
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
    work_body: input.workItem.body,
    ticket_number: String(input.workItem.number),
    spec_number: String(input.workItem.specNumber),
    fixed_point: input.fixedPoint,
  };
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
