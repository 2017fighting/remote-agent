import { jobName } from "@remote-agent/shared";
import { FakeGitHub } from "../src/fakes/FakeGitHub.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import type { GitHubIssue } from "../src/ports/GitHubPort.js";
import type { K8sJob } from "../src/ports/K8sPort.js";

/** Shared world builder for the App seam (spec #33 Testing Decisions 1). */

export const REPO = "2017fighting/remote-agent";
export const OTHER_REPO = "2017fighting/pi-web";

export function issue(
  number: number,
  labels: string[],
  overrides: Partial<GitHubIssue> = {},
): GitHubIssue {
  return {
    ownerRepo: REPO,
    number,
    state: "open",
    title: `Issue ${number}`,
    body: `Body of #${number}`,
    labels,
    ...overrides,
  };
}

export const GATE_LABELS = ["ready-for-agent", "agent:implement"];

/** A spec with its sub-issues, all in the gate unless overridden. */
export function specWorld(options: {
  specNumber: number;
  subIssueNumbers: number[];
  ownerRepo?: string;
  subIssueLabels?: Record<number, string[]>;
  blockers?: Array<{ issueNumber: number; blockerNumbers: number[] }>;
  extraIssues?: GitHubIssue[];
}): FakeGitHub {
  const ownerRepo = options.ownerRepo ?? REPO;
  const spec = issue(options.specNumber, GATE_LABELS, { ownerRepo });
  const subs = options.subIssueNumbers.map((n) =>
    issue(n, options.subIssueLabels?.[n] ?? GATE_LABELS, { ownerRepo }),
  );
  return new FakeGitHub({
    issues: [spec, ...subs, ...(options.extraIssues ?? [])],
    subIssues: [{ ownerRepo, specNumber: options.specNumber, issueNumbers: options.subIssueNumbers }],
    blockers: (options.blockers ?? []).map((b) => ({
      ownerRepo,
      issueNumber: b.issueNumber,
      blockerNumbers: b.blockerNumbers,
    })),
  });
}

/** A managed Job object in the world, as the App itself would have created it. */
export function managedJob(
  ownerRepo: string,
  issueNumber: number,
  options: { finished?: boolean; runningPod?: boolean; repoLabel?: string; role?: string } = {},
): K8sJob {
  return {
    name: jobName(ownerRepo, issueNumber),
    namespace: "remote-agent",
    labels: {
      "app.kubernetes.io/managed-by": "remote-agent",
      "remote-agent/ticket": `${ownerRepo}#${issueNumber}`,
      "remote-agent/repo": options.repoLabel ?? ownerRepo,
      "remote-agent/role": options.role ?? "implement-ticket",
    },
    annotations: {},
    conditions: [],
    finished: options.finished ?? false,
  };
}

/**
 * The spec's closeout Job (`implement-spec`) under its deterministic name: the
 * same naming rule as a ticket Job, applied to the spec's own number.
 */
export function closeoutJob(
  ownerRepo: string,
  specNumber: number,
  options: { finished?: boolean; annotation?: string; failedReason?: string } = {},
): K8sJob {
  const job = managedJob(ownerRepo, specNumber, { finished: options.finished ?? false, role: "implement-spec" });
  if (options.failedReason !== undefined) {
    job.conditions = [{ type: "Failed", status: "True", reason: options.failedReason }];
  } else if (options.finished) {
    job.conditions = [{ type: "Complete", status: "True" }];
  }
  if (options.annotation !== undefined) job.annotations["remote-agent/run-result"] = options.annotation;
  return job;
}

/** A spec whose every sub-issue is closed: the closeout Job's turn (S1 → S2). */
export function closedOutSpecWorld(options: { specNumber: number; subIssueNumbers: number[] }) {
  const spec = issue(options.specNumber, GATE_LABELS);
  const subs = options.subIssueNumbers.map((n) => issue(n, GATE_LABELS, { state: "closed" }));
  return new FakeGitHub({
    issues: [spec, ...subs],
    subIssues: [
      { ownerRepo: REPO, specNumber: options.specNumber, issueNumbers: options.subIssueNumbers },
    ],
  });
}
