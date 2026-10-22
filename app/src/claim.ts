import { secretName } from "@remote-agent/shared";
import { LABEL_AGENT_IN_PROGRESS } from "./planners/gate.js";
import { renderJobManifest, renderTicketPvc, type AgentRole } from "./renders/job-template.js";
import { renderTokenSecret } from "./renders/token-steward.js";
import { isAlreadyExists, isQuotaExceeded } from "./ports/errors.js";
import type { AppConfig } from "./config.js";
import type { GitHubPort } from "./ports/GitHubPort.js";
import type { K8sPort } from "./ports/K8sPort.js";

/**
 * Claim execution (spec #33 §2 step 3, ADR-0013). Write order is
 *
 *   Ticket PVC (if absent) → per-Job Secret (mint) → Job (if absent) → `agent:in-progress`
 *
 * Job before label is deliberate: crashing between the two leaves "Job running
 * + ticket still in the gate", which the k8s half of the gate absorbs next
 * pass. The reverse order would leave "in-progress + no Job" — a fake T6e.
 *
 * Existence is probed by deterministic name (RBAC has no `secrets list`), which
 * is also what makes a replay free: on an unchanged world the PVC and the
 * Secret are already there, so nothing is created and no token is minted.
 *
 * Two error classes carry product meaning:
 * - `409 AlreadyExists` is **success** — every create is create-if-absent, so a
 *   create that raced another pass is not a failure.
 * - `403 quota exceeded` (the Guardrail ResourceQuota) is a **normal branch**:
 *   no Job this pass, no label change, no comment, no `agent:error`.
 *
 * Any other failure stops the pass at this ticket; the next pass recomputes
 * from world state, so there is no half-state to clean up.
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

export type ClaimResult =
  | { kind: "claimed"; jobName: string }
  /** The Job object was already there (a create raced us): nothing more to do this pass. */
  | { kind: "already-claimed"; jobName: string }
  /** Guardrail quota said no: normal branch, next pass recomputes. */
  | { kind: "quota-exceeded"; jobName: string }
  /** Any other failure: the pass stops here. */
  | { kind: "failed"; jobName: string; error: unknown };

export async function claimTicket(input: ClaimTicketInput): Promise<ClaimResult> {
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
    // 1. Ticket PVC — long-lived, one per ticket (ADR-0011).
    if ((await k8s.getPvc(pvc.name)) === null) {
      await createIfAbsent(() => k8s.createPvc(pvc));
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

    // 4. Label last (ADR-0013): the Claim is this label edit.
    await github.editLabels(targetRepo, issueNumber, [LABEL_AGENT_IN_PROGRESS], []);

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
