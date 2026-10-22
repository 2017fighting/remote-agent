/**
 * Scripted OpenAI-compatible model service (spec #33 Testing Decisions 3).
 *
 * The runner talks to OmniRoute through `@earendil-works/pi-ai`'s
 * `openai-completions` API, which is a streaming `/chat/completions` client.
 * This service answers that wire protocol from a script instead of from a
 * model: each scenario step names the tool calls the "model" should emit, and
 * the verdicts (`code_review` findings, `finish_*` payloads) come from the
 * fixture. No network, no cost, deterministic.
 *
 * The script is consumed in order, one step per request. A step is addressed by
 * the model id the runner asked for (`default` for the runner, `review` for the
 * reviewer conversation), so a scenario can keep the two conversations apart
 * without either side knowing it is talking to a stub.
 *
 * Wire shape (what pi-ai's openai-completions parser reads):
 *   data: {"id","model","choices":[{"index":0,"delta":{...},"finish_reason":null}]}
 *   data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
 *   data: [DONE]
 */

export interface ScriptedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id?: string;
}

/** One assistant turn: text, tool calls, or both. */
export interface ScriptStep {
  /** Model id this step answers; omitted = any model. */
  model?: string;
  text?: string;
  toolCalls?: ScriptedToolCall[];
  /** Defaults to `tool_calls` when there are tool calls, else `stop`. */
  finishReason?: "stop" | "tool_calls";
}

export interface ModelScript {
  steps: ScriptStep[];
}

export interface ScriptedModelOptions {
  scriptPath: string;
  /** Recorded request log; every call is appended here for assertions. */
  recordPath?: string;
}

export interface RecordedModelRequest {
  at: string;
  model: string;
  /** The tool names the runner offered in this request (its current tool table). */
  offeredTools: string[];
  /** The last user message's text, trimmed — what the "model" is reacting to. */
  lastUserMessage: string;
  step: number;
}

/** Pull the tool names out of an OpenAI `tools` array. */
function offeredToolNames(body: Record<string, unknown>): string[] {
  const tools = body["tools"];
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => {
      const fn = (tool as { function?: { name?: unknown } }).function;
      return typeof fn?.name === "string" ? fn.name : undefined;
    })
    .filter((name): name is string => name !== undefined);
}

/** The most recent `role: "user"` message's text content. */
function lastUserText(body: Record<string, unknown>): string {
  const messages = body["messages"];
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        })
        .join("");
    }
    return "";
  }
  return "";
}

export { offeredToolNames, lastUserText };

/** Serve one scripted completion as a stream of SSE chunks. */
export function renderStream(step: ScriptStep, model: string, completionId: string): string {
  const chunks: string[] = [];
  const push = (delta: Record<string, unknown>, finishReason: string | null): void => {
    chunks.push(
      `data: ${JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  };

  if (step.text !== undefined && step.text !== "") {
    push({ role: "assistant", content: step.text }, null);
  }
  const toolCalls = step.toolCalls ?? [];
  if (toolCalls.length > 0) {
    toolCalls.forEach((call, index) => {
      push(
        {
          role: "assistant",
          tool_calls: [
            {
              index,
              id: call.id ?? `call_${index}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            },
          ],
        },
        null,
      );
    });
  }
  const finishReason = step.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop");
  push({}, finishReason);
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

/** The next script step for a model id, in order, skipping steps for other models. */
export class ScriptCursor {
  private index = 0;

  constructor(private readonly steps: ScriptStep[]) {}

  /** Steps are matched by model when the step names one; otherwise in order. */
  next(model: string): { step: ScriptStep; index: number } {
    for (let scan = this.index; scan < this.steps.length; scan += 1) {
      const candidate = this.steps[scan]!;
      if (candidate.model !== undefined && candidate.model !== model) continue;
      this.index = scan + 1;
      return { step: candidate, index: scan };
    }
    throw new Error(
      `stub-model: no scripted step left for model ${model} (consumed ${this.index}/${this.steps.length}); ` +
        "the scenario script is shorter than the run's request count",
    );
  }

  get consumed(): number {
    return this.index;
  }
}
