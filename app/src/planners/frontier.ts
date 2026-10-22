import { jobName } from "@remote-agent/shared";
import type { GitHubIssue } from "../ports/GitHubPort.js";
import type { K8sJob } from "../ports/K8sPort.js";
import { claimGate } from "./gate.js";

/**
 * Frontier (docs/architecture.md §4.2): the spec's first sub-issue that passes
 * the Claim-gate. Three outcomes, because the spec loop acts differently on
 * each (S1 → Claim / idle / closeout):
 *
 * - `has-frontier` — claim this ticket;
 * - `no-frontier-open-sub-issues` — tickets are blocked / errored / waiting on
 *   a Job: do nothing, log only;
 * - `all-closed` — nothing left: the closeout Job's turn.
 *
 * Order is the sub-issue list order as GitHub returns it, so the same world
 * always yields the same frontier. The spec's sub-issues are tried in that
 * order; specs themselves are ordered by number by the caller.
 */

export type FrontierOutcome =
  | { kind: "has-frontier"; ticket: GitHubIssue }
  | { kind: "no-frontier-open-sub-issues"; openSubIssues: GitHubIssue[] }
  | { kind: "all-closed" };

export interface FrontierInput {
  ownerRepo: string;
  /** Sub-issues in their listed order (determinism source). */
  subIssues: GitHubIssue[];
  /** issue number → count of that issue's still-open blockers. */
  openBlockerCounts: ReadonlyMap<number, number>;
  /** Every Job object currently in the namespace, by name. */
  jobsByName: ReadonlyMap<string, K8sJob>;
}

export function planFrontier(input: FrontierInput): FrontierOutcome {
  const openSubIssues = input.subIssues.filter((issue) => issue.state === "open");

  for (const issue of openSubIssues) {
    const existingJob = input.jobsByName.get(jobName(input.ownerRepo, issue.number)) ?? null;
    const gate = claimGate({
      issue,
      openBlockerCount: input.openBlockerCounts.get(issue.number) ?? 0,
      existingJob,
    });
    if (gate.passed) return { kind: "has-frontier", ticket: issue };
  }

  if (openSubIssues.length === 0) return { kind: "all-closed" };
  return { kind: "no-frontier-open-sub-issues", openSubIssues };
}
