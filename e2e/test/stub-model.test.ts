import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { startStubModel, type StubModel } from "../stub-model/server.js";
import type { ModelScript } from "../stub-model/script.js";

/**
 * The stub model's external behavior: it answers the OpenAI streaming wire
 * protocol pi-ai's `openai-completions` client parses, it emits the tool calls
 * the fixture names, and it addresses steps by model id so a scenario can keep
 * the runner and reviewer conversations apart.
 *
 * The parse below is deliberately the same shape the real client consumes
 * (`data:` frames → `choices[0].delta` → `finish_reason`), so a script that
 * passes here is one the runner will understand.
 */

function parseSse(payload: string): Array<Record<string, unknown>> {
  return payload
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>);
}

function deltas(chunks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return chunks
    .map((chunk) => (chunk["choices"] as Array<{ delta?: Record<string, unknown> }>)[0]?.delta)
    .filter((delta): delta is Record<string, unknown> => delta !== undefined);
}

describe("stub-model", () => {
  let stub: StubModel | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await stub?.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    stub = undefined;
    root = undefined;
  });

  async function start(script: ModelScript): Promise<{ stub: StubModel; base: string }> {
    root = await mkdtemp(join(tmpdir(), "stub-model-"));
    const scriptPath = join(root, "script.json");
    await writeFile(scriptPath, JSON.stringify(script));
    stub = await startStubModel({ scriptPath, port: 0 });
    return { stub, base: `http://127.0.0.1:${stub.port}` };
  }

  function complete(base: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ model: "default", stream: true, messages: [{ role: "user", content: "go" }], ...body }),
    });
  }

  it("lists the two model ids the provider declares", async () => {
    const { base } = await start({ steps: [] });
    const models = (await (await fetch(`${base}/v1/models`)).json()) as { data: Array<{ id: string }> };
    expect(models.data.map((model) => model.id)).toEqual(["default", "review"]);
  });

  it("streams a text answer as SSE ending in finish_reason=stop", async () => {
    const { base } = await start({ steps: [{ text: "hello there" }] });
    const chunks = parseSse(await (await complete(base, {})).text());
    expect(deltas(chunks)).toContainEqual({ role: "assistant", content: "hello there" });
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "stop" }] });
  });

  it("streams a tool call with JSON arguments and finish_reason=tool_calls", async () => {
    const { base } = await start({
      steps: [
        {
          toolCalls: [{ name: "finish_ticket", arguments: { summary: "did it" }, id: "call-1" }],
        },
      ],
    });
    const chunks = parseSse(await (await complete(base, {})).text());
    const call = deltas(chunks).find((delta) => delta["tool_calls"] !== undefined);
    expect(call?.["tool_calls"]).toEqual([
      {
        index: 0,
        id: "call-1",
        type: "function",
        function: { name: "finish_ticket", arguments: JSON.stringify({ summary: "did it" }) },
      },
    ]);
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: "tool_calls" }] });
  });

  it("addresses steps by model id so the reviewer and runner keep separate scripts", async () => {
    const { stub: server, base } = await start({
      steps: [
        { model: "default", toolCalls: [{ name: "read", arguments: { path: "a" } }] },
        { model: "review", text: "standards look fine" },
        { model: "default", toolCalls: [{ name: "finish_ticket", arguments: { summary: "s" } }] },
      ],
    });
    await complete(base, { model: "default" });
    await complete(base, { model: "review" });
    await complete(base, { model: "default" });
    expect(server.requests.map((request) => request.model)).toEqual(["default", "review", "default"]);
    expect(server.requests[1]?.step).toBe(1);
  });

  it("records the offered tool table and the last user message of each request", async () => {
    const { stub: server, base } = await start({ steps: [{ text: "ok" }] });
    await complete(base, {
      tools: [
        { type: "function", function: { name: "read" } },
        { type: "function", function: { name: "finish_ticket" } },
      ],
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "implement ticket 34" },
      ],
    });
    expect(server.requests[0]?.offeredTools).toEqual(["read", "finish_ticket"]);
    expect(server.requests[0]?.lastUserMessage).toBe("implement ticket 34");
  });

  it("fails loudly when the script runs out, naming the model and the count", async () => {
    const { base } = await start({ steps: [{ text: "only one" }] });
    await complete(base, {});
    const second = await complete(base, {});
    expect(second.status).toBe(500);
    expect(await second.text()).toContain("no scripted step left for model default");
  });

  it("404s a route that is not the completions endpoint", async () => {
    const { base } = await start({ steps: [] });
    expect((await fetch(`${base}/v1/embeddings`, { method: "POST" })).status).toBe(404);
  });

  /**
   * The decisive check: the runner's own client parses the stub. A script that
   * passes only my own SSE reader would prove nothing about the runner; this
   * drives `@earendil-works/pi-ai`'s openai-completions API — the same one
   * `job/src/internal/provider.ts` wires — against the stub.
   */
  it("is parsed by the real pi-ai client the runner uses, tool call and all", async () => {
    const { stub: server, base } = await start({
      steps: [
        { model: "default", toolCalls: [{ name: "finish_ticket", arguments: { summary: "done" }, id: "c1" }] },
      ],
    });
    const baseUrl = `${base}/v1`;
    process.env["OMNIROUTE_API_KEY"] = "test-key";
    const models = createModels();
    models.setProvider(
      createProvider({
        id: "omniroute",
        name: "OmniRoute",
        baseUrl,
        auth: { apiKey: envApiKeyAuth("OmniRoute API key", ["OMNIROUTE_API_KEY"]) },
        api: openAICompletionsApi(),
        models: [
          {
            api: "openai-completions",
            provider: "omniroute",
            id: "default",
            name: "default",
            baseUrl,
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_000_000,
            maxTokens: 131_072,
          },
        ],
      }),
    );
    const model = models.getModel("omniroute", "default");
    if (model === undefined) throw new Error("the stub model catalog is missing its model");

    const events: Array<{ type: string; message?: { content: unknown[]; stopReason: string } }> = [];
    for await (const event of models.stream(model, { messages: [{ role: "user", content: "go" }] })) {
      events.push(event as (typeof events)[number]);
    }
    const done = events.find((event) => event.type === "done");
    expect(done?.message?.stopReason).toBe("toolUse");
    expect(done?.message?.content).toContainEqual({
      type: "toolCall",
      id: "c1",
      name: "finish_ticket",
      arguments: { summary: "done" },
    });
    expect(server.requests).toHaveLength(1);
  });
});
