import { describe, expect, it } from "vitest";
import { ANNOTATIONS, jobName, tokenSecretName } from "@remote-agent/shared";
import { runReconcilePass } from "../src/reconcile.js";
import { TOKEN_RENEWAL_THRESHOLD_SECONDS, tokenRenewalDecision } from "../src/planners/token-steward.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import { testConfig } from "./helpers.js";
import { GATE_LABELS, REPO, managedJob, specWorld, ticketPvc, tokenSecret } from "./world.js";

/**
 * Token renewal on the App seam (ADR-0009 / ADR-0014): one pass over a world
 * that holds a running Job and its per-Job Secret. Asserts external behaviour
 * only — how many tokens were minted, whether the Secret was patched, and the
 * value the annotation ends up carrying.
 *
 * The threshold is 30 minutes, and the judgement reads **only**
 * `remote-agent/token-expires-at` — the `creationTimestamp` cases below pin
 * that a stale-looking Secret with a valid token is not renewed, and a
 * fresh-looking Secret with a nearly expired token is.
 */

const NOW = new Date("2025-03-01T12:00:00.000Z");
const TICKET = 37;
const config = testConfig();

function at(minutesFromNow: number): string {
  return new Date(NOW.getTime() + minutesFromNow * 60 * 1000).toISOString();
}

/** A world with one running Job, its Secret and its Ticket PVC. */
function runningWorld(options: {
  tokenExpiresAt?: string;
  creationTimestamp?: string;
  token?: string;
  finished?: boolean;
}) {
  const github = specWorld({
    specNumber: 33,
    subIssueNumbers: [TICKET],
    subIssueLabels: { [TICKET]: [...GATE_LABELS, "agent:in-progress"] },
  });
  const k8s = new FakeK8s({
    jobs: [managedJob(REPO, TICKET, { finished: options.finished ?? false })],
    pvcs: [ticketPvc(REPO, TICKET)],
    secrets: [
      tokenSecret(REPO, TICKET, {
        tokenExpiresAt: options.tokenExpiresAt,
        creationTimestamp: options.creationTimestamp,
        token: options.token,
      }),
    ],
  });
  return { github, k8s };
}

function run(deps: { github: ReturnType<typeof runningWorld>["github"]; k8s: FakeK8s }) {
  return runReconcilePass({ ...deps, config, now: () => NOW }, "tick");
}

function mints(github: ReturnType<typeof runningWorld>["github"]): string[] {
  return github.writeLog.filter((entry) => entry.startsWith("mintInstallationToken"));
}

describe("token renewal: the 30-minute threshold", () => {
  it("does not mint while 30 minutes or more remain", async () => {
    const world = runningWorld({ tokenExpiresAt: at(30) });
    const result = await run(world);

    expect(mints(world.github)).toEqual([]);
    expect(world.k8s.writeLog.filter((w) => w.startsWith("patchSecret"))).toEqual([]);
    expect(result.renewed).toBe(0);
    expect(world.k8s.secrets[0]!.data["token"]).toBe("ghs_existing");
    expect(world.k8s.secrets[0]!.annotations[ANNOTATIONS.tokenExpiresAt]).toBe(at(30));
  });

  it("re-mints once and refreshes the annotation when less than 30 minutes remain", async () => {
    const world = runningWorld({ tokenExpiresAt: at(29) });
    const result = await run(world);

    expect(mints(world.github)).toEqual([`mintInstallationToken ${REPO}`]);
    expect(world.k8s.writeLog.filter((w) => w.startsWith("patchSecret"))).toEqual([
      `patchSecret ${tokenSecretName(jobName(REPO, TICKET))}`,
    ]);
    expect(result.renewed).toBe(1);
    const secret = world.k8s.secrets[0]!;
    expect(secret.data["token"]).toMatch(/^ghs_/);
    expect(secret.data["token"]).not.toBe("ghs_existing");
    expect(secret.annotations[ANNOTATIONS.tokenExpiresAt]).not.toBe(at(29));
  });

  it("re-mints an already expired token for the same reason", async () => {
    const world = runningWorld({ tokenExpiresAt: at(-5) });
    expect((await run(world)).renewed).toBe(1);
    expect(mints(world.github)).toHaveLength(1);
  });

  it("re-mints a Secret whose expiry annotation is missing (unknown life, self-healing)", async () => {
    const world = runningWorld({});
    expect((await run(world)).renewed).toBe(1);
    // The annotation this pass wrote is what the next pass judges.
    expect(world.k8s.secrets[0]!.annotations[ANNOTATIONS.tokenExpiresAt]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("mints at most one token per Secret per pass", async () => {
    const world = runningWorld({ tokenExpiresAt: at(1) });
    await run(world);
    expect(mints(world.github)).toHaveLength(1);
    expect(world.k8s.writeLog.filter((w) => w.startsWith("patchSecret"))).toHaveLength(1);

    // Replay over the post-renewal world: the annotation now carries the fresh
    // 60-minute expiry, so the second pass judges "keep" and writes nothing.
    const k8sWrites = world.k8s.writeLog.length;
    await run(world);
    expect(world.k8s.writeLog.length).toBe(k8sWrites);
    expect(mints(world.github)).toHaveLength(1);
  });

  it("leaves a finished Job's Secret alone (nothing reads that token any more)", async () => {
    const world = runningWorld({ tokenExpiresAt: at(1), finished: true });
    const result = await run(world);

    expect(mints(world.github)).toEqual([]);
    expect(result.renewed).toBe(0);
  });
});

describe("token renewal: the judgement ignores creationTimestamp", () => {
  it("does not renew an old Secret whose token is still valid", async () => {
    // A patch never moves creationTimestamp, so a Secret renewed hours ago still
    // looks old. Judging from it would re-mint every pass (ADR-0014).
    const world = runningWorld({ tokenExpiresAt: at(45), creationTimestamp: "2024-01-01T00:00:00Z" });
    expect((await run(world)).renewed).toBe(0);
    expect(mints(world.github)).toEqual([]);
  });

  it("renews a brand-new Secret whose token is nearly expired", async () => {
    const world = runningWorld({ tokenExpiresAt: at(5), creationTimestamp: NOW.toISOString() });
    expect((await run(world)).renewed).toBe(1);
  });

  it("the pure decision is a function of the annotation and the clock only", () => {
    const expiring = { tokenExpiresAt: at(10), now: NOW };
    const valid = { tokenExpiresAt: at(TOKEN_RENEWAL_THRESHOLD_SECONDS / 60), now: NOW };

    expect(tokenRenewalDecision(expiring)).toEqual({ kind: "renew", reason: "expiring" });
    expect(tokenRenewalDecision(valid)).toEqual({ kind: "keep", remainingSeconds: TOKEN_RENEWAL_THRESHOLD_SECONDS });
    expect(tokenRenewalDecision({ tokenExpiresAt: undefined, now: NOW })).toEqual({
      kind: "renew",
      reason: "no-expiry",
    });
    expect(tokenRenewalDecision({ tokenExpiresAt: "not-a-date", now: NOW })).toEqual({
      kind: "renew",
      reason: "no-expiry",
    });
  });
});

describe("token renewal: scope", () => {
  it("never touches Jobs (k8s TTL owns Job deletion, ADR-0012)", async () => {
    const world = runningWorld({ tokenExpiresAt: at(1) });
    await run(world);
    expect(world.k8s.writeLog.filter((w) => w.includes("Job"))).toEqual([]);
  });

  it("does not patch a Secret it did not create (no provenance label on the Job)", async () => {
    const world = runningWorld({ tokenExpiresAt: at(1) });
    world.k8s.jobs[0]!.labels = {};
    expect((await run(world)).renewed).toBe(0);
    expect(mints(world.github)).toEqual([]);
  });
});
