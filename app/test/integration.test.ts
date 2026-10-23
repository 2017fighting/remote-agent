import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createScheduler, formatPassLog, type PassLog } from "../src/scheduler.js";
import { createWebhookServer } from "../src/server.js";
import { runReconcilePass } from "../src/reconcile.js";
import { FakeGitHub } from "../src/fakes/FakeGitHub.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import { readAppConfig } from "../src/config.js";

/**
 * Whole-surface wiring on the App seam: a signed webhook delivery →
 * scheduler wake → exactly one reconcile pass → one structured log line with
 * the trigger and five counters, over HTTP 200. Everything runs against the
 * in-memory fake world (spec #33 Testing Decisions 1).
 */

const SECRET = "integration-secret";

function sign(payload: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(payload).digest("hex");
}

describe("signed webhook → scheduler → one reconcile pass", () => {
  let lines: PassLog[];
  let errors: Array<{ trigger: string }>;
  let github: FakeGitHub;
  let k8s: FakeK8s;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    lines = [];
    errors = [];
    github = new FakeGitHub({
      issues: [
        {
          ownerRepo: "2017fighting/remote-agent",
          number: 34,
          state: "open",
          title: "App skeleton",
          body: "...",
          labels: ["ready-for-agent", "agent:implement"],
        },
      ],
    });
    k8s = new FakeK8s();
    const config = readAppConfig({});

    const scheduler = createScheduler(config, {
      reconcile: (trigger) => runReconcilePass({ github, k8s, config }, trigger),
      listIssues: () => github.listIssues(),
      onPassLog: (line) => lines.push(line),
      onPassError: (trigger) => errors.push({ trigger }),
    });

    const server = createWebhookServer({ webhookSecret: SECRET, wake: (t) => scheduler.wake(t) });
    await server.ready();
    cleanup = async () => {
      scheduler.stop();
      await server.close();
    };

    // startup: list + one trigger=startup pass (acceptance: process startup)
    await scheduler.start();
    expect(lines.map((l) => l.trigger)).toEqual(["startup"]);

    const payload = JSON.stringify({ action: "labeled", issue: { number: 34 } });
    const res = await fetch(`http://${server.host}:${server.port}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-hub-signature-256": sign(payload),
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    // Let the scheduler run the woken pass to completion.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    void scheduler;
  });

  afterEach(async () => {
    await cleanup();
  });

  it("produces exactly one pass with trigger=webhook and a full structured log line", () => {
    expect(lines.map((l) => l.trigger)).toEqual(["startup", "webhook"]);
    const line = lines[1]!;
    expect(Object.hasOwn(line, "trigger")).toBe(true);
    expect(Object.hasOwn(line, "slotsUsed")).toBe(true);
    expect(Object.hasOwn(line, "slotsMax")).toBe(true);
    expect(Object.hasOwn(line, "deferred")).toBe(true);
    expect(Object.hasOwn(line, "renewed")).toBe(true);
    expect(Object.hasOwn(line, "waiting")).toBe(true);
    expect(Object.hasOwn(line, "idle")).toBe(true);
    expect(formatPassLog(line)).toBe("pass trigger=webhook slots=0/3 deferred=0 renewed=0 waiting=0 idle=0");
    expect(errors).toEqual([]);
  });

  it("the pass made no external writes (empty plan in #34)", () => {
    expect(github.writeLog).toEqual([]);
    expect(k8s.writeLog).toEqual([]);
  });
});
