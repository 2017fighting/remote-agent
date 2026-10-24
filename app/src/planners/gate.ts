import type { GitHubIssue } from "../ports/GitHubPort.js";
import type { K8sJob } from "../ports/K8sPort.js";

/**
 * Gate and Claim-gate (docs/architecture.md §4.2, ADR-0013). Pure functions:
 * the world is passed in, nothing is read or written here.
 *
 * ```
 * Loop(issue)         ⟺ open ∧ no open blocker ∧ ready-for-agent ∧ no agent:*
 * Gate(issue)         ⟺ Loop(issue) ∧ authorized(issue)
 * Claim-gate(issue)   ⟺ Gate ∧ no Job object under the deterministic name (terminal or not)
 * authorized(ticket)  ⟺ own agent:implement ∨ Gate(parent spec)
 * ```
 *
 * The two halves are split because they answer different questions (ticket #46):
 * **Loop** is "this issue's own facts say work may happen here", and
 * **authorized** is "a human said an agent may do it". A spec drives its
 * sub-issues when it is in the Loop — its own `agent:implement` is not required
 * for that, because a ticket may carry its own. A spec's own *run* (the
 * closeout, S2–S5) still needs the full Gate: that run is the spec's, so it
 * needs the spec's authorization.
 *
 * **Authorization is inherited; nothing else is.** A ticket whose parent spec
 * carries `agent:implement` is in the gate without the label of its own, which
 * is what makes "authorize the spec once, never per ticket" true. A ticket's own
 * `agent:implement` keeps working with no authorized parent: that is the manual
 * "implement just this one" entry point. `ready-for-agent`, blockers, state and
 * the exit markers stay the ticket's own facts — they are never read off the
 * parent.
 *
 * Inheritance is a judgement, not a write: Claim never copies
 * `agent:implement` onto the ticket, so the label set on an issue keeps meaning
 * "what a human wrote there".
 *
 * The k8s half is load-bearing on its own (ADR-0013): a Job object still in its
 * retention window means the annotation of that run was already consumed (or is
 * still live), so the correct action is to wait for its `DELETED` event — do not
 * claim, do not create, do not read the old annotation.
 */

export const LABEL_READY_FOR_AGENT = "ready-for-agent";
export const LABEL_READY_FOR_HUMAN = "ready-for-human";
export const LABEL_AGENT_IMPLEMENT = "agent:implement";
export const LABEL_AGENT_IN_PROGRESS = "agent:in-progress";
export const LABEL_AGENT_BLOCKED = "agent:blocked";
export const LABEL_AGENT_ERROR = "agent:error";
// The seventh label the App writes, `closeout-consumed`, deliberately does not
// live here: no gate condition reads it (it marks a consumed spec-loop outcome,
// not a claimable state), so it belongs to the planner that owns its life cycle
// — `LABEL_CLOSEOUT_CONSUMED` in planners/spec-loop.ts (ticket #49).

/**
 * Every `agent:*` label other than `agent:implement` is an exit marker
 * (in-progress / error / blocked) — none of them belongs on a claimable issue.
 * `agent:implement` is the authorization itself, so it is excluded here.
 */
const AGENT_LABEL_PREFIX = "agent:";

function hasBlockingAgentLabel(labels: string[]): boolean {
  return labels.some((label) => label.startsWith(AGENT_LABEL_PREFIX) && label !== LABEL_AGENT_IMPLEMENT);
}

/** A ticket's parent spec, as the pass already read it. */
export interface ParentSpec {
  issue: GitHubIssue;
  /** Blockers that are still open on the spec itself. */
  openBlockerCount: number;
}

/** The issue's own facts — what `Loop` reads. */
export interface LoopInput {
  issue: GitHubIssue;
  /** Blockers that are still open hold the issue at the Gate. */
  openBlockerCount: number;
}

export interface LabelGateInput extends LoopInput {
  /**
   * The parent spec, when this issue is one of its sub-issues. Authorization is
   * the one condition read off it (ticket #46). A spec has no parent, so its own
   * gate passes no `parentSpec` and inherits nothing.
   */
  parentSpec?: ParentSpec;
}

export interface GateInput extends LabelGateInput {
  /** The Job object under this issue's deterministic name, if any (terminal or not). */
  existingJob: K8sJob | null;
}

export type GateFailure =
  | "closed"
  | "open-blocker"
  | "missing-ready-for-agent"
  | "missing-agent-implement"
  | "agent-label-present"
  /** No own `agent:implement`, and the parent spec it would inherit from is not itself in the gate. */
  | "spec-out-of-gate"
  | "job-object-present";

export type GateResult = { passed: true } | { passed: false; reason: GateFailure };

/**
 * The four conditions that are the issue's own facts, authorization excluded:
 * "this issue is somewhere work may happen". The code form of the glossary's
 * `Loop`, split out because a spec drives its sub-issues on this alone (ticket
 * #46) while its own closeout needs the full Gate.
 */
export function loopGate(input: LoopInput): GateResult {
  const { issue, openBlockerCount } = input;
  if (issue.state !== "open") return { passed: false, reason: "closed" };
  if (openBlockerCount > 0) return { passed: false, reason: "open-blocker" };
  if (!issue.labels.includes(LABEL_READY_FOR_AGENT)) {
    return { passed: false, reason: "missing-ready-for-agent" };
  }
  // An exit marker is the issue's own verdict on itself, so it outranks
  // authorization: an inherited authorization cannot resurrect a blocked or
  // errored ticket, and cannot enter one a Job is already holding.
  if (hasBlockingAgentLabel(issue.labels)) {
    return { passed: false, reason: "agent-label-present" };
  }
  return { passed: true };
}

/**
 * The authorization condition alone: the ticket's own `agent:implement`, or the
 * one its parent spec lends it. The parent's *whole* Gate decides: an authorized
 * spec that is itself blocked, errored, closed or not `ready-for-agent` lends
 * nothing.
 */
export function authorizationGate(input: LabelGateInput): GateResult {
  if (input.issue.labels.includes(LABEL_AGENT_IMPLEMENT)) return { passed: true };
  if (input.parentSpec === undefined) return { passed: false, reason: "missing-agent-implement" };
  // A spec has no parent of its own, so this recursion is one level deep.
  const spec = labelGate({ issue: input.parentSpec.issue, openBlockerCount: input.parentSpec.openBlockerCount });
  if (!spec.passed) return { passed: false, reason: "spec-out-of-gate" };
  return { passed: true };
}

/**
 * Label half only. Split out because a spec's closeout uses the same label
 * gate while its k8s half is a different deterministic name.
 */
export function labelGate(input: LabelGateInput): GateResult {
  const loop = loopGate(input);
  if (!loop.passed) return loop;
  return authorizationGate(input);
}

/** Full Claim-gate: the label half plus the k8s half (ADR-0013). */
export function claimGate(input: GateInput): GateResult {
  const label = labelGate(input);
  if (!label.passed) return label;
  if (input.existingJob !== null) return { passed: false, reason: "job-object-present" };
  return { passed: true };
}
