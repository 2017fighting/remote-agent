import { ANNOTATIONS, LABELS, secretName } from "@remote-agent/shared";
import type { MintedToken } from "../ports/GitHubPort.js";
import type { K8sSecret } from "../ports/K8sPort.js";

/**
 * Per-Job credential (ADR-0009): one installation token scoped to the target
 * repo with `contents: write` only, written into `agent-<repo-slug>-<issue#>-token`
 * and mounted as a file. The expiry is GitHub's own `expires_at`, stored on the
 * Secret so renewal never has to guess from `creationTimestamp` (ADR-0014).
 *
 * This renders the mint-at-Claim shape; `token-renewal.ts` patches the same two
 * fields in place when the token is close to expiring.
 */

import { TOKEN_SECRET_KEY } from "./job-template.js";

export function renderTokenSecret(input: {
  namespace: string;
  targetRepo: string;
  issueNumber: number;
  specNumber: number;
  minted: MintedToken;
}): K8sSecret {
  const { namespace, targetRepo, issueNumber, specNumber, minted } = input;
  return {
    name: secretName(targetRepo, issueNumber),
    namespace,
    annotations: { [ANNOTATIONS.tokenExpiresAt]: minted.expiresAt },
    labels: {
      [LABELS.managedBy]: LABELS.managedByValue,
      [LABELS.ticket]: `${targetRepo}#${issueNumber}`,
      [LABELS.spec]: String(specNumber),
    },
    data: { [TOKEN_SECRET_KEY]: minted.token },
  };
}
