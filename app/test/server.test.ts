import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebhookServer, type WebhookServer } from "../src/server.js";
import type { Trigger } from "../src/scheduler.js";

/**
 * /webhook endpoint (#34): HMAC verification + event-type filter
 * (issues / issue_comment / sub_issues / issue_dependencies /
 * installation_repositories) → a scheduler wake signal only. It never parses
 * business content and never triggers more than one pass per delivery.
 */

const SECRET = "test-webhook-secret";

function sign(payload: string, secret = SECRET): string {
  return "sha256=" + Buffer.from(hmacSha256(secret, payload)).toString("hex");
}

// node:crypto via dynamic-free import: use the Web Crypto-free sync hmac from crypto
import { createHmac } from "node:crypto";
function hmacSha256(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

interface Harness {
  wakes: Trigger[];
  server: WebhookServer;
  url: string;
}

async function makeHarness(): Promise<Harness> {
  const wakes: Trigger[] = [];
  const server = createWebhookServer({
    webhookSecret: SECRET,
    wake: (trigger) => wakes.push(trigger),
  });
  await server.ready();
  const url = `http://${server.host}:${server.port}`;
  return { wakes, server, url };
}

function post(url: string, path: string, headers: Record<string, string>, body: string): Promise<Response> {
  return fetch(`${url}${path}`, { method: "POST", headers, body });
}

function webhookHeaders(event: string, payload: string, signature: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-github-event": event,
    "x-hub-signature-256": signature,
  };
}

describe("/webhook endpoint", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.server.close();
  });

  it("a correctly signed webhook POST wakes exactly one pass with trigger=webhook and returns 200", async () => {
    const payload = JSON.stringify({ action: "labeled", issue: { number: 34 } });
    const res = await post(h.url, "/webhook", webhookHeaders("issues", payload, sign(payload)), payload);
    expect(res.status).toBe(200);
    expect(h.wakes).toEqual(["webhook"]);
  });

  it.each(["issue_comment", "sub_issues", "issue_dependencies", "installation_repositories"])(
    "event %s also wakes one pass",
    async (event) => {
      const payload = JSON.stringify({ action: "created" });
      const res = await post(h.url, "/webhook", webhookHeaders(event, payload, sign(payload)), payload);
      expect(res.status).toBe(200);
      expect(h.wakes).toEqual(["webhook"]);
    },
  );

  it("a bad signature returns 401 and wakes nothing", async () => {
    const payload = JSON.stringify({ action: "labeled" });
    const res = await post(
      h.url,
      "/webhook",
      webhookHeaders("issues", payload, sign(payload, "wrong-secret")),
      payload,
    );
    expect(res.status).toBe(401);
    expect(h.wakes).toEqual([]);
  });

  it("an unrelated event type returns 200 and wakes nothing", async () => {
    const payload = JSON.stringify({ action: "started" });
    const res = await post(
      h.url,
      "/webhook",
      webhookHeaders("workflow_run", payload, sign(payload)),
      payload,
    );
    expect(res.status).toBe(200);
    expect(h.wakes).toEqual([]);
  });

  it("a non-/webhook path returns 404 and never throws", async () => {
    const payload = "{}";
    const res = await post(h.url, "/healthz", webhookHeaders("issues", payload, sign(payload)), payload);
    expect(res.status).toBe(404);
    expect(h.wakes).toEqual([]);
  });

  it("a request without the event header returns 400 and wakes nothing", async () => {
    const payload = "{}";
    const res = await post(h.url, "/webhook", { "content-type": "application/json", "x-hub-signature-256": sign(payload) }, payload);
    expect(res.status).toBe(400);
    expect(h.wakes).toEqual([]);
  });
});
