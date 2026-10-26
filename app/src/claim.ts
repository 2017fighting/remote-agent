import { ANNOTATIONS, secretName } from "@remote-agent/shared";
import { LABEL_AGENT_IN_PROGRESS } from "./planners/gate.js";
import { reclaimTicketVolume } from "./reclamation.js";
import { renderJobManifest, renderTicketPvc, type AgentRole } from "./renders/job-template.js";
import { renderTokenSecret } from "./renders/token-steward.js";
import { isAlreadyExists, isQuotaExceeded } from "./ports/errors.js";
import type { AppConfig } from "./config.js";
import type { GitHubPort } from "./ports/GitHubPort.js";
import type { K8sPort } from "./ports/K8sPort.js";

/**
 * Job start-up (spec #33 §2 steps 3 and 4, ADR-0013). Write order is
 *
 *   PVC (if absent) → per-Job Secret (mint) → Job (if absent) → `agent:in-progress`
 *
 * and for the closeout role the volume step is a *reclaim* instead of a create:
 *
 *   reclaim the spent PVC + Secret (ADR-0016) → PVC → Secret → Job
 *
 * Job before label is deliberate: crashing between the two leaves "Job running
 * + ticket still in the gate", which the k8s half of the gate absorbs next
 * pass. The reverse order would leave "in-progress + no Job" — a fake T6e.
 *
 * The spec's closeout Job runs the same sequence minus the label: a spec never
 * carries `agent:in-progress` (§4.5), so its "already consumed" marker is the
 * label migration the outcome performs. Everything else — the deterministic
 * name, the volume, the minted token, create-if-absent, the k8s half of the
 * Claim-gate — is the same door, not a second one.
 *
 * Existence is probed by deterministic name (RBAC has no `secrets list`), which
 * is also what makes a replay free: on an unchanged world the PVC and the
 * Secret are already there, so nothing is created and no token is minted.
 *
 * The PVC probe does one more thing on the reuse path, and which one depends on
 * the role:
 *
 * - **a ticket's volume is reused**: `remote-agent/expires-at` is cleared (ADR-0011
 *   — set when the outcome was judged, cleared when the volume is claimed again),
 *   so a re-entry resumes the same conversation. The clear is a no-op when the key
 *   is absent, so the replay stays write-free.
 * - **a closeout's volume is spent**: the closeout role's conversation is terminal
 *   once it reported, so a second round on that volume could only no-op (the seed
 *   skips on its matching marker, the runner sees the finished run and exits
 *   without an annotation). The volume and its Secret are reclaimed first, so the
 *   next round seeds from nothing (ADR-0016, ticket #60).
 *
 * Two error classes carry product meaning:
 * - `409 AlreadyExists` is **success** — every create is create-if-absent, so a
 *   create that raced another pass is not a failure.
 * - `403 quota exceeded` (the Guardrail ResourceQuota) is a **normal branch**:
 *   no Job this pass, no label change, no comment, no `agent:error`.
 *
 * Any other failure stops the pass at this Job; the next pass recomputes from
 * world state, so there is no half-state to clean up.
 */

export interface ClaimTicketInput {
  config: AppConfig;
  github: GitHubPort;
  k8s: K8sPort;
  targetRepo: string;
  issueNumber: number;
  specNumber: number;
  role: AgentRole;
  workItemJson: string;
}

/** The spec closeout Job: same deterministic name rule, applied to the spec's own number. */
export interface StartCloseoutJobInput {
  config: AppConfig;
  github: GitHubPort;
  k8s: K8sPort;
  targetRepo: string;
  specNumber: number;
  workItemJson: string;
}

export type ClaimResult =
  | { kind: "claimed"; jobName: string }
  /** The Job object was already there (a create raced us): nothing more to do this pass. */
  | { kind: "already-claimed"; jobName: string }
  /** Guardrail quota said no: normal branch, next pass recomputes. */
  | { kind: "quota-exceeded"; jobName: string }
  /** Any other failure: the pass stops here. */
  | { kind: "failed"; jobName: string; error: unknown };

export async function claimTicket(input: ClaimTicketInput): Promise<ClaimResult> {
  return startAgentJob({ ...input, markInProgress: true, reclaimSpentVolume: false });
}

/** S1 → S2: start the closeout Job. No label write — a spec never carries `agent:in-progress`. */
export async function startCloseoutJob(input: StartCloseoutJobInput): Promise<ClaimResult> {
  return startAgentJob({
    ...input,
    issueNumber: input.specNumber,
    role: "implement-spec",
    markInProgress: false,
    // The spec's own run: its volume is spent once it has reported, so this round
    // starts on a fresh one (ADR-0016, ticket #60).
    reclaimSpentVolume: true,
  });
}

interface AgentJobInput {
  config: AppConfig;
  github: GitHubPort;
  k8s: K8sPort;
  targetRepo: string;
  issueNumber: number;
  specNumber: number;
  role: AgentRole;
  workItemJson: string;
  /** The Claim *is* the label edit; only the ticket role has one. */
  markInProgress: boolean;
  /**
   * Reclaim the volume under the deterministic name instead of reusing it
   * (ADR-0016). Only the closeout role sets it: a ticket's volume is meant to be
   * reused, a closeout's is **spent** the moment its round reported.
   */
  reclaimSpentVolume: boolean;
}

async function startAgentJob(input: AgentJobInput): Promise<ClaimResult> {
  const { config, github, k8s, targetRepo, issueNumber, specNumber } = input;
  const pvc = renderTicketPvc({ config, targetRepo, issueNumber, specNumber });
  const job = renderJobManifest({
    config,
    targetRepo,
    issueNumber,
    specNumber,
    role: input.role,
    workItemJson: input.workItemJson,
  });

  try {
    // 1. Volume — long-lived, one per issue (ADR-0011). A volume reused from a
    //    judged run still carries `remote-agent/expires-at`; this is where that
    //    retention clock stops (an absent value = not deletable).
    if ((await k8s.getPvc(pvc.name)) === null) {
      await createIfAbsent(() => k8s.createPvc(pvc));
    } else if (input.reclaimSpentVolume) {
      // A spent volume: its conversation is terminal, so this round cannot run on
      // it. Reclaim it and its credential, then create a fresh one below
      // (ADR-0016). Deleting before creating is what makes the seed and the
      // runner start from nothing.
      await reclaimTicketVolume(k8s, pvc.name);
      await createIfAbsent(() => k8s.createPvc(pvc));
    } else {
      await k8s.clearPvcAnnotation(pvc.name, ANNOTATIONS.expiresAt);
    }

    // 2. Per-Job Secret — mint only when absent, so a replay mints nothing.
    const tokenSecretName = secretName(targetRepo, issueNumber);
    if ((await k8s.getSecret(tokenSecretName)) === null) {
      const minted = await github.mintInstallationToken(targetRepo);
      await createIfAbsent(() =>
        k8s.createSecret(
          renderTokenSecret({ namespace: config.namespace, targetRepo, issueNumber, specNumber, minted }),
        ),
      );
    }

    // 3. Job — create-if-absent under the deterministic name.
    const created = await createIfAbsent(() => k8s.createJob(job));

    // 4. Label last (ADR-0013): for a ticket the Claim is this label edit.
    if (input.markInProgress) {
      await github.editLabels(targetRepo, issueNumber, [LABEL_AGENT_IN_PROGRESS], []);
    }

    return { kind: created ? "claimed" : "already-claimed", jobName: job.name };
  } catch (error) {
    if (isQuotaExceeded(error)) return { kind: "quota-exceeded", jobName: job.name };
    return { kind: "failed", jobName: job.name, error };
  }
}

/** True when this call actually created the object; false when it already existed (409 = success). */
async function createIfAbsent(create: () => Promise<unknown>): Promise<boolean> {
  try {
    await create();
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }
}
