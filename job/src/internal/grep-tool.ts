import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern (regular expression, or a literal string with literal=true)" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search, relative to the working copy" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat the pattern as a literal string (default: false)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matching lines to return (default: 100)" })),
});

const DEFAULT_LIMIT = 100;

/**
 * `grep` for the reviewer conversation (spec #33 §6): the reviewer's tool table
 * is `read` / `grep` / `bash`, and pi-durable ships no `grep` tool, so the Job
 * image carries this one. It shells out to `git grep` through the environment,
 * so it reads only the working copy's tracked files and needs no credentials.
 */
export function createGrepTool(): ToolRegistration<typeof grepSchema> {
  return defineTool({
    name: "grep",
    description:
      "Search the working copy's tracked files for a pattern. Returns matching lines with file paths and line numbers. Read-only.",
    parameters: grepSchema,
    execute: async (args, api, context) => {
      const env = api.env;
      if (env === undefined) throw new Error("No execution environment is configured");
      const argv = ["git", "grep", "--no-color", "-n", "-I"];
      if (args.ignoreCase === true) argv.push("-i");
      if (args.literal === true) argv.push("-F");
      argv.push("-e", args.pattern);
      if (args.path !== undefined && args.path !== "") argv.push("--", args.path);

      let stdout = "";
      const result = await env.exec(argv, { cwd: env.cwd, env: {}, inheritEnv: true, onOutput: (text) => (stdout += text) }, context);
      if (!result.ok) throw new Error(`grep failed: ${result.error.message}`);
      // `git grep` exits 1 for "no match", which is a normal answer, not a failure.
      if (result.value.exitCode !== 0 && result.value.exitCode !== 1) {
        throw new Error(`git grep exited ${result.value.exitCode}`);
      }
      const lines = stdout.replace(/\n$/, "") === "" ? [] : stdout.replace(/\n$/, "").split("\n");
      if (lines.length === 0) return { output: [{ type: "text", text: `no matches for ${args.pattern}` }] };
      const shown = lines.slice(0, args.limit ?? DEFAULT_LIMIT);
      const omitted = lines.length - shown.length;
      const text = omitted === 0 ? shown.join("\n") : `${shown.join("\n")}\n… ${omitted} more matching lines omitted`;
      return { output: [{ type: "text", text }] };
    },
  });
}
