import { ANNOTATIONS, LABELS, jobName, pvcName, tokenSecretName } from "@remote-agent/shared";
import { FakeGitHub } from "../src/fakes/FakeGitHub.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import type { GitHubIssue } from "../src/ports/GitHubPort.js";
import type { K8sJob, K8sPvc, K8sSecret } from "../src/ports/K8sPort.js";

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

/** A Ticket PVC as the App created it, provenance labels included (ADR-0011). */
export function ticketPvc(
  ownerRepo: string,
  issueNumber: number,
  options: { expiresAt?: string; creationTimestamp?: string; spec?: number } = {},
): K8sPvc {
  return {
    name: pvcName(ownerRepo, issueNumber),
    namespace: "remote-agent",
    annotations: options.expiresAt === undefined ? {} : { [ANNOTATIONS.expiresAt]: options.expiresAt },
    labels: {
      [LABELS.managedBy]: LABELS.managedByValue,
      [LABELS.ticket]: `${ownerRepo}#${issueNumber}`,
      [LABELS.spec]: String(options.spec ?? 33),
    },
    creationTimestamp: options.creationTimestamp,
  };
}

/** A per-Job token Secret as Claim left it (ADR-0009). */
export function tokenSecret(
  ownerRepo: string,
  issueNumber: number,
  options: { tokenExpiresAt?: string; creationTimestamp?: string; token?: string } = {},
): K8sSecret {
  return {
    name: tokenSecretName(jobName(ownerRepo, issueNumber)),
    namespace: "remote-agent",
    annotations:
      options.tokenExpiresAt === undefined ? {} : { [ANNOTATIONS.tokenExpiresAt]: options.tokenExpiresAt },
    labels: {
      [LABELS.managedBy]: LABELS.managedByValue,
      [LABELS.ticket]: `${ownerRepo}#${issueNumber}`,
      [LABELS.spec]: "33",
    },
    data: { token: options.token ?? "ghs_existing" },
    creationTimestamp: options.creationTimestamp,
  };
}
