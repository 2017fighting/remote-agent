import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { startApp } from "../src/main.js";
import { FakeGitHub } from "../src/fakes/FakeGitHub.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import { specWorld } from "./world.js";

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
      // One structured line for the startup pass, plus its volume stats line.
      expect(logLines).toContain("pass trigger=startup slots=0/3 deferred=0 renewed=0 waiting=0 closeout-consumed=0 idle=0");
      expect(logLines).toContain("volumes live=0 oldest-expiry=none per-spec=none");

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
      expect(passLines[1]).toBe("pass trigger=webhook slots=0/3 deferred=0 renewed=0 waiting=0 closeout-consumed=0 idle=0");
      // Every pass also emits the volume stats line (ADR-0011).
      expect(logLines.filter((l) => l.startsWith("volumes "))).toHaveLength(2);
    } finally {
      await app.stop();
    }
  });

  it("prints the idle counter and one idle-spec reason line when the Frontier is empty", async () => {
    // Ticket #47's whole point: this world used to log `... waiting=0` and
    // nothing else, which read as "the webhook never arrived". The reason line
    // is what tells the operator a human has to re-enter the ticket.
    const github = specWorld({
      specNumber: 33,
      subIssueNumbers: [34, 35],
      subIssueLabels: {
        34: ["ready-for-human", "agent:implement", "agent:blocked"],
        35: ["ready-for-human", "agent:implement", "agent:error"],
      },
    });
    const logLines: string[] = [];
    const app = await startApp({
      env: {},
      github,
      k8s: new FakeK8s(),
      log: (line) => logLines.push(line),
      webhookSecret: SECRET,
    });
    try {
      expect(logLines).toContain("pass trigger=startup slots=0/3 deferred=0 renewed=0 waiting=0 closeout-consumed=0 idle=1");
      expect(logLines).toContain("idle-spec spec=33 open-sub-issues=2 reasons=exit-marker:2");
      // No external write: the pass only counted (and so did every later pass).
      expect(github.writeLog).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  it("the Job watch is a live wake source: a DELETED event wakes a pass", async () => {
    // Story 8's escape hatch: `kubectl delete job <name>` must wake Claim
    // immediately. The evidence comment promises exactly that, so a watch that is
    // never subscribed would make the App lie to a human.
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
      // The watch must be subscribed by startup, not on the first webhook.
      expect(k8s.watcherCount).toBeGreaterThan(0);

      // A real Job object has to exist for the DELETED event to fire.
      await k8s.createJob({
        name: "agent-o-r-1",
        namespace: "remote-agent",
        labels: {},
        annotations: {},
        parallelism: 1,
        backoffLimit: 4,
        activeDeadlineSeconds: 10800,
        ttlSecondsAfterFinished: 1800,
        podFailurePolicy: { rules: [] },
        podTemplate: {
          serviceAccountName: "agent-job",
          restartPolicy: "Never",
          terminationGracePeriodSeconds: 120,
          securityContext: { fsGroup: 1000 },
          initContainers: [],
          containers: [],
          volumes: [],
        },
      });
      k8s.deleteJob("agent-o-r-1");
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const passLines = logLines.filter((line) => line.startsWith("pass "));
      expect(passLines.at(-1)).toBe("pass trigger=job-watch slots=0/3 deferred=0 renewed=0 waiting=0 closeout-consumed=0 idle=0");
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

  it("binds PORT on all interfaces, so the Service and the readiness probe can reach it", async () => {
    // The image declares PORT=8080 and the Deployment probes that port over the
    // pod IP; a loopback-only or ephemeral listener is unreachable in-cluster.
    const port = 18080 + Math.floor(Math.random() * 1000);
    const logLines: string[] = [];
    const app = await startApp({
      env: { PORT: String(port) },
      github: new FakeGitHub(),
      k8s: new FakeK8s(),
      log: (line) => logLines.push(line),
      webhookSecret: SECRET,
    });
    try {
      expect(logLines).toContain(`webhook listening on 0.0.0.0:${port}/webhook`);
      const payload = JSON.stringify({ action: "labeled" });
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
    } finally {
      await app.stop();
    }
  });
});
