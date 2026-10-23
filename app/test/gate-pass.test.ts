import { describe, expect, it } from "vitest";
import { runReconcilePass } from "../src/reconcile.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import { testConfig } from "./helpers.js";
import { GATE_LABELS, REPO, issue, managedJob, specWorld } from "./world.js";

/**
 * The Gate as the pass sees it (docs/architecture.md §4.2): each condition
 * missing alone means **no action** — no PVC, no Secret, no mint, no Job, no
 * label, no comment. Table-driven over the world, asserted on write calls
 * (spec #33 Testing Decisions: external behaviour only).
 *
 * The k8s half of the Claim-gate is in the same table: a Job object under the
 * deterministic name, terminal or not, stops the claim and the annotation is
 * not read.
 */

const config = testConfig();

interface Case {
  name: string;
  /** Sub-issue labels (defaults to the fully authorized set). */
  ticketLabels?: string[];
  /** Sub-issue state. */
  ticketState?: "open" | "closed";
  /** Spec labels (defaults to the fully authorized set). */
  specLabels?: string[];
  /** Spec state. */
  specState?: "open" | "closed";
  /** A blocker on the ticket, and whether that blocker is open. */
  blocker?: { open: boolean };
  /** A Job object under the ticket's deterministic name. */
  existingJob?: "running" | "terminal";
  /**
   * `agent:in-progress` is the one label the pass acts on rather than skipping:
   * with no Job under the deterministic name it is the T6e fallback (an error),
   * so the "no action" assertion does not apply to it.
   */
  inProgress?: boolean;
  /**
   * The one case where "nothing to claim" still means a write: with every
   * sub-issue closed the spec loop starts its closeout Job (§4.5 S1 → S2).
   */
  closeout?: boolean;
  /**
   * A case that claims: the ticket's own `agent:implement` authorizes it
   * regardless of the spec's (ticket #46), and the baseline holds anyway.
   */
  claims?: boolean;
}

const cases: Case[] = [
  { name: "the baseline: every condition holds → claim", claims: true },
  { name: "ticket closed", ticketState: "closed", closeout: true },
  { name: "ticket has an open blocker", blocker: { open: true } },
  { name: "ticket missing ready-for-agent", ticketLabels: ["agent:implement"] },
  // Nobody is authorized: the ticket has no `agent:implement` of its own and the
  // spec has none either, so there is nothing to inherit (ticket #46).
  {
    name: "ticket missing agent:implement and spec missing it too",
    ticketLabels: ["ready-for-agent"],
    specLabels: ["ready-for-agent"],
  },
  { name: "ticket already agent:in-progress", ticketLabels: [...GATE_LABELS, "agent:in-progress"], inProgress: true },
  { name: "ticket agent:blocked", ticketLabels: ["ready-for-human", "agent:implement", "agent:blocked"] },
  { name: "ticket agent:error", ticketLabels: ["ready-for-human", "agent:implement", "agent:error"] },
  // The spec's own authorization is not needed to advance a ticket (ticket #46),
  // so this case is now a claim: see the inheritance block below.
  { name: "spec has no agent:implement, the ticket does", specLabels: ["ready-for-agent"], claims: true },
  { name: "spec closed", specState: "closed" },
  { name: "old Job object still present (non-terminal)", existingJob: "running" },
  { name: "old terminal Job object inside its retention window", existingJob: "terminal" },
];

describe("Gate: each condition missing alone means no action", () => {
  for (const c of cases) {
    const shouldClaim = c.claims === true;

    it(`${shouldClaim ? "claims" : "does nothing"} — ${c.name}`, async () => {
      const blockerNumber = 900;
      const github = specWorld({
        specNumber: 33,
        subIssueNumbers: [35],
        subIssueLabels: c.ticketLabels ? { 35: c.ticketLabels } : undefined,
        blockers: c.blocker ? [{ issueNumber: 35, blockerNumbers: [blockerNumber] }] : undefined,
        extraIssues: [
          ...(c.blocker
            ? [issue(blockerNumber, [], { state: c.blocker.open ? "open" : "closed" })]
            : []),
        ],
      });
      github.issues[0] = issue(33, c.specLabels ?? GATE_LABELS, { state: c.specState ?? "open" });
      if (c.ticketState) {
        const ticket = github.issues.find((i) => i.number === 35)!;
        ticket.state = c.ticketState;
      }
      const k8s = new FakeK8s(
        c.existingJob
          ? {
              jobs: [
                managedJob(REPO, 35, { finished: c.existingJob === "terminal" }),
              ],
            }
          : undefined,
      );
      // An old run's annotation must not be consumed by the claim path.
      if (c.existingJob) {
        k8s.jobs[0]!.annotations["remote-agent/run-result"] = '{"v":1,"outcome":"done","summary":"old"}';
      }

      await runReconcilePass({ github, k8s, config }, "webhook");

      if (shouldClaim) {
        expect(k8s.writeLog).toEqual([
          `createPvc agent-2017fighting-remote-agent-35`,
          `createSecret agent-2017fighting-remote-agent-35-token`,
          `createJob agent-2017fighting-remote-agent-35`,
        ]);
        expect(github.writeLog).toContain(`editLabels ${REPO}#35 +[agent:in-progress] -[]`);
        return;
      }

      if (c.closeout) {
        // No claim, but the spec has no open sub-issue left: S2 starts the
        // closeout Job, which is a Job like any other (same PVC/Secret/name).
        expect(k8s.writeLog).toEqual([
          `createPvc agent-2017fighting-remote-agent-33`,
          `createSecret agent-2017fighting-remote-agent-33-token`,
          `createJob agent-2017fighting-remote-agent-33`,
        ]);
        // The only GitHub write is the token mint: a spec never gets a label
        // change from the closeout Job (§4.5 — no `agent:in-progress`).
        expect(github.writeLog).toEqual([`mintInstallationToken ${REPO}`]);
        expect((await github.getIssue(REPO, 33))?.labels).toEqual(GATE_LABELS);
        return;
      }

      expect(k8s.writeLog, "no k8s writes").toEqual([]);
      if (c.inProgress) {
        // T6e: in-progress with no Job is the App's availability fallback.
        expect(github.writeLog).toContain(
          `editLabels ${REPO}#35 +[ready-for-human,agent:error] -[ready-for-agent,agent:in-progress]`,
        );
        expect(github.comments, "one evidence comment").toHaveLength(1);
        return;
      }
      expect(github.writeLog, "no GitHub writes").toEqual([]);
      expect(github.comments, "no comments").toEqual([]);
      expect((await github.getIssue(REPO, 35))?.labels).toEqual(c.ticketLabels ?? GATE_LABELS);
      // The old annotation is still there and untouched: the gate did not consume it.
      if (c.existingJob) {
        expect(k8s.jobs[0]!.annotations["remote-agent/run-result"]).toBe('{"v":1,"outcome":"done","summary":"old"}');
      }
    });
  }

  it("a closed blocker does not hold the ticket", async () => {
    const github = specWorld({
      specNumber: 33,
      subIssueNumbers: [35],
      blockers: [{ issueNumber: 35, blockerNumbers: [900] }],
      extraIssues: [issue(900, [], { state: "closed" })],
    });
    const k8s = new FakeK8s();
    await runReconcilePass({ github, k8s, config }, "webhook");
    expect(k8s.jobs.map((j) => j.name)).toEqual(["agent-2017fighting-remote-agent-35"]);
  });
});

/**
 * Authorization inherited from the parent spec (ticket #46, docs/architecture.md
 * §4.2): a spec that a human authorized once makes its `ready-for-agent`
 * sub-issues claimable without a per-ticket `agent:implement`. Asserted on the
 * write calls and the final labels, because the second half of the rule is what
 * inheritance must *not* do — copy the label onto the ticket.
 */
describe("Gate: a ticket inherits its spec's agent:implement", () => {
  const SPEC = 33;
  const TICKET = 34;
  const TICKET_ONLY_READY = ["ready-for-agent"];

  /** One spec, one sub-issue that has never carried `agent:implement`. */
  function world(specLabels: string[] = GATE_LABELS) {
    const github = specWorld({ specNumber: SPEC, subIssueNumbers: [TICKET], subIssueLabels: { [TICKET]: TICKET_ONLY_READY } });
    github.issues[0] = issue(SPEC, specLabels);
    return github;
  }

  it("claims the first runnable ticket in the same write order as before", async () => {
    const github = world();
    const k8s = new FakeK8s();

    const result = await runReconcilePass({ github, k8s, config }, "webhook");

    // PVC → Secret → Job → agent:in-progress, unchanged by the inherited path.
    expect(k8s.writeLog).toEqual([
      `createPvc agent-2017fighting-remote-agent-${TICKET}`,
      `createSecret agent-2017fighting-remote-agent-${TICKET}-token`,
      `createJob agent-2017fighting-remote-agent-${TICKET}`,
    ]);
    expect(github.writeLog).toContain(`editLabels ${REPO}#${TICKET} +[agent:in-progress] -[]`);
    expect(result.slotsUsed).toBe(1);
  });

  it("never writes agent:implement down onto the ticket", async () => {
    const github = world();
    const k8s = new FakeK8s();

    await runReconcilePass({ github, k8s, config }, "webhook");

    // The label set records what a human wrote, so the inherited authorization
    // leaves the ticket's own labels untouched apart from the claim marker.
    expect([...((await github.getIssue(REPO, TICKET))?.labels ?? [])].sort()).toEqual([
      "agent:in-progress",
      "ready-for-agent",
    ]);
    for (const write of github.writeLog) expect(write).not.toContain("+[agent:implement");
  });

  it("a ticket with its own agent:implement is claimed even when the spec has none", async () => {
    // The manual "implement just this one" entry point.
    const github = specWorld({ specNumber: SPEC, subIssueNumbers: [TICKET] });
    github.issues[0] = issue(SPEC, ["ready-for-agent"]);
    const k8s = new FakeK8s();

    await runReconcilePass({ github, k8s, config }, "webhook");

    expect(k8s.jobs.map((job) => job.name)).toEqual([`agent-2017fighting-remote-agent-${TICKET}`]);
    expect(github.writeLog).toContain(`editLabels ${REPO}#${TICKET} +[agent:in-progress] -[]`);
  });

  it("writes nothing when neither the ticket nor the spec is authorized", async () => {
    const github = world(["ready-for-agent"]);
    const k8s = new FakeK8s();

    await runReconcilePass({ github, k8s, config }, "webhook");

    expect(k8s.writeLog).toEqual([]);
    expect(github.writeLog).toEqual([]);
    expect(github.comments).toEqual([]);
  });

  const specOutOfGate: Array<{ name: string; labels: string[]; state?: "open" | "closed" }> = [
    { name: "the spec is not ready-for-agent", labels: ["agent:implement"] },
    { name: "the spec carries agent:error", labels: ["ready-for-human", "agent:implement", "agent:error"] },
    { name: "the spec carries agent:blocked", labels: ["ready-for-human", "agent:implement", "agent:blocked"] },
    { name: "the spec is closed", labels: GATE_LABELS, state: "closed" },
  ];

  for (const c of specOutOfGate) {
    it(`inheritance does not apply when ${c.name}`, async () => {
      const github = world(c.labels);
      github.issues[0]!.state = c.state ?? "open";
      const k8s = new FakeK8s();

      await runReconcilePass({ github, k8s, config }, "webhook");

      expect(k8s.writeLog).toEqual([]);
      expect(github.writeLog).toEqual([]);
      expect((await github.getIssue(REPO, TICKET))?.labels).toEqual(TICKET_ONLY_READY);
    });
  }

  it("inheritance does not apply when the spec has an open blocker", async () => {
    const github = specWorld({
      specNumber: SPEC,
      subIssueNumbers: [TICKET],
      subIssueLabels: { [TICKET]: TICKET_ONLY_READY },
      blockers: [{ issueNumber: SPEC, blockerNumbers: [900] }],
      extraIssues: [issue(900, [], { state: "open" })],
    });
    const k8s = new FakeK8s();

    await runReconcilePass({ github, k8s, config }, "webhook");

    expect(k8s.writeLog).toEqual([]);
    expect(github.writeLog).toEqual([]);
  });

  it("counts the inherited path as waiting when the ticket's Job object lingers", async () => {
    // `waiting` = inside the label gate but held by the k8s half (ADR-0013).
    // The label gate now includes inherited authorization, so the counter must
    // agree with it, otherwise a spec whose tickets are all waiting looks idle.
    const github = world();
    const k8s = new FakeK8s({ jobs: [managedJob(REPO, TICKET)] });

    const result = await runReconcilePass({ github, k8s, config }, "tick");

    expect(result.waiting).toBe(1);
    expect(result.deferred).toBe(0);
    expect(result.slotsUsed).toBe(0);
    expect(github.writeLog).toEqual([]);
    expect(k8s.writeLog).toEqual([]);
  });

  it("does not count an unauthorized ticket as waiting, even with a Job object around", async () => {
    const github = world(["ready-for-agent"]);
    const k8s = new FakeK8s({ jobs: [managedJob(REPO, TICKET)] });

    const result = await runReconcilePass({ github, k8s, config }, "tick");

    expect(result.waiting).toBe(0);
    expect(github.writeLog).toEqual([]);
    expect(k8s.writeLog).toEqual([]);
  });

  it("the second ticket is the Frontier while the first one's Job object lingers (ADR-0013)", async () => {
    const github = specWorld({
      specNumber: SPEC,
      subIssueNumbers: [34, 35],
      subIssueLabels: { 34: TICKET_ONLY_READY, 35: TICKET_ONLY_READY },
    });
    const k8s = new FakeK8s({ jobs: [managedJob(REPO, 34, { finished: true })] });

    const result = await runReconcilePass({ github, k8s, config }, "webhook");

    // 34 is inside the (inherited) label gate but held by the k8s half; 35 is
    // therefore the first claimable sub-issue, and 34 is what `waiting` counts.
    expect(result.waiting).toBe(1);
    expect(k8s.jobs.map((job) => job.name)).toEqual([
      "agent-2017fighting-remote-agent-34",
      "agent-2017fighting-remote-agent-35",
    ]);
  });
});
