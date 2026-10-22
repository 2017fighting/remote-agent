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
}

const cases: Case[] = [
  { name: "the baseline: every condition holds → claim", },
  { name: "ticket closed", ticketState: "closed" },
  { name: "ticket has an open blocker", blocker: { open: true } },
  { name: "ticket missing ready-for-agent", ticketLabels: ["agent:implement"] },
  { name: "ticket missing agent:implement", ticketLabels: ["ready-for-agent"] },
  { name: "ticket already agent:in-progress", ticketLabels: [...GATE_LABELS, "agent:in-progress"], inProgress: true },
  { name: "ticket agent:blocked", ticketLabels: ["ready-for-human", "agent:implement", "agent:blocked"] },
  { name: "ticket agent:error", ticketLabels: ["ready-for-human", "agent:implement", "agent:error"] },
  { name: "spec out of the gate (no agent:implement)", specLabels: ["ready-for-agent"] },
  { name: "spec closed", specState: "closed" },
  { name: "old Job object still present (non-terminal)", existingJob: "running" },
  { name: "old terminal Job object inside its retention window", existingJob: "terminal" },
];

describe("Gate: each condition missing alone means no action", () => {
  for (const c of cases) {
    const shouldClaim = c.name.startsWith("the baseline");

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
