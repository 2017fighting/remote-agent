import type { GitHubIssue } from "../ports/GitHubPort.js";
import type { K8sJob } from "../ports/K8sPort.js";

/**
 * Gate and Claim-gate (docs/architecture.md §4.2, ADR-0013). Pure functions:
 * the world is passed in, nothing is read or written here.
 *
 * ```
 * Gate(issue)         ⟺ open ∧ no open blocker ∧ ready-for-agent ∧ agent:implement ∧ no agent:*
 * Claim-gate(issue)   ⟺ Gate ∧ no Job object under the deterministic name (terminal or not)
 * ```
 *
 * The k8s half is load-bearing on its own (ADR-0013): a Job object still in its
 * retention window means the annotation of that run was already consumed (or is
 * still live), so the correct action is to wait for its `DELETED` event — do not
 * claim, do not create, do not read the old annotation.
 */

export const LABEL_READY_FOR_AGENT = "ready-for-agent";
export const LABEL_AGENT_IMPLEMENT = "agent:implement";
export const LABEL_AGENT_IN_PROGRESS = "agent:in-progress";

/**
 * Every `agent:*` label other than `agent:implement` is an exit marker
 * (in-progress / error / blocked) — none of them belongs on a claimable issue.
 * `agent:implement` is the authorization itself, so it is excluded here.
 */
const AGENT_LABEL_PREFIX = "agent:";

function hasBlockingAgentLabel(labels: string[]): boolean {
  return labels.some((label) => label.startsWith(AGENT_LABEL_PREFIX) && label !== LABEL_AGENT_IMPLEMENT);
}

export interface GateInput {
  issue: GitHubIssue;
  /** Blockers that are still open hold the issue at the Gate. */
  openBlockerCount: number;
  /** The Job object under this issue's deterministic name, if any (terminal or not). */
  existingJob: K8sJob | null;
}

export type GateFailure =
  | "closed"
  | "open-blocker"
  | "missing-ready-for-agent"
  | "missing-agent-implement"
  | "agent-label-present"
  | "job-object-present";

export type GateResult = { passed: true } | { passed: false; reason: GateFailure };

/**
 * Label half only. Split out because a spec's closeout uses the same label
 * gate while its k8s half is a different deterministic name.
 */
export function labelGate(issue: GitHubIssue, openBlockerCount: number): GateResult {
  if (issue.state !== "open") return { passed: false, reason: "closed" };
  if (openBlockerCount > 0) return { passed: false, reason: "open-blocker" };
  if (!issue.labels.includes(LABEL_READY_FOR_AGENT)) {
    return { passed: false, reason: "missing-ready-for-agent" };
  }
  if (!issue.labels.includes(LABEL_AGENT_IMPLEMENT)) {
    return { passed: false, reason: "missing-agent-implement" };
  }
  if (hasBlockingAgentLabel(issue.labels)) {
    return { passed: false, reason: "agent-label-present" };
  }
  return { passed: true };
}

/** Full Claim-gate: the label half plus the k8s half (ADR-0013). */
export function claimGate(input: GateInput): GateResult {
  const label = labelGate(input.issue, input.openBlockerCount);
  if (!label.passed) return label;
  if (input.existingJob !== null) return { passed: false, reason: "job-object-present" };
  return { passed: true };
}
