import { createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { createGrepTool } from "./grep-tool.js";

export const REVIEWER_EXTENSION_NAME = "remote-agent-reviewer";

/**
 * The reviewer conversation's tool table, and the whole structural guarantee
 * against fan-out (spec #33 §6): `read`, `grep`, `bash` — no `code_review`, no
 * subagent tool. The reviewer gets `bash` because it runs `git diff` / `git log`
 * itself; read-only is the prompt's job, and `bash` alone opens no fan-out.
 *
 * A reviewer conversation selects this extension and nothing else, so its tool
 * table is exactly these three names.
 */
export function reviewerExtension(): Extension {
  return defineExtension({
    name: REVIEWER_EXTENSION_NAME,
    tools: [createReadTool(), createGrepTool(), createBashTool()],
  });
}
