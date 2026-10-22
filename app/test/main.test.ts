import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { startApp } from "../src/main.js";
import { FakeGitHub } from "../src/fakes/FakeGitHub.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";

/**
 * The App entry point wiring on the App seam: startup list + trigger=startup
 * pass, webhook surface live, fake ports injected exactly like production
 * adapters would be (same signatures).
 */

function sign(secret: string, payload: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

const SECRET = "main-secret";

describe("startApp wiring", () => {
  it("startup: one list, one trigger=startup pass, webhook 200 on signed delivery", async () => {
    const github = new FakeGitHub({
      issues: [
        {
          ownerRepo: "o/r",
          number: 1,
          state: "open",
          title: "t",
          body: "b",
          labels: [],
        },
      ],
    });
    const k8s = new FakeK8s();
    const logLines: string[] = [];
    const app = await startApp({
      env: {},
      github,
      k8s,
      log: (line) => logLines.push(line),
      webhookSecret: SECRET,
    });
    try {
      // One structured line for the startup pass.
      expect(logLines).toContain("pass trigger=startup slots=0/3 deferred=0 renewed=0 waiting=0");

      const payload = JSON.stringify({ action: "labeled" });
      const port = Number(logLines.find((l) => l.startsWith("webhook listening"))!.match(/:(\d+)/)![1]);
      const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": sign(SECRET, payload),
        },
        body: payload,
      });
      expect(res.status).toBe(200);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      const passLines = logLines.filter((l) => l.startsWith("pass "));
      expect(passLines).toHaveLength(2);
      expect(passLines[1]).toBe("pass trigger=webhook slots=0/3 deferred=0 renewed=0 waiting=0");
    } finally {
      await app.stop();
    }
  });

  it("rejects a bad signature without waking a pass", async () => {
    const github = new FakeGitHub();
    const k8s = new FakeK8s();
    const logLines: string[] = [];
    const app = await startApp({
      env: {},
      github,
      k8s,
      log: (line) => logLines.push(line),
      webhookSecret: SECRET,
    });
    try {
      const payload = JSON.stringify({ action: "labeled" });
      const port = Number(logLines.find((l) => l.startsWith("webhook listening"))!.match(/:(\d+)/)![1]);
      const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": sign("wrong", payload),
        },
        body: payload,
      });
      expect(res.status).toBe(401);
      await new Promise((r) => setImmediate(r));
      expect(logLines.filter((l) => l.startsWith("pass "))).toHaveLength(1); // startup only
    } finally {
      await app.stop();
    }
  });
});
