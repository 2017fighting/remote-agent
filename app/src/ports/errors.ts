/**
 * Kubernetes API error classes the decision layer branches on. The port throws
 * these (adapters translate client-node / HTTP errors into them) so planners
 * never inspect adapter internals.
 *
 * Two classifications carry product meaning (spec #33 §2):
 * - `409 AlreadyExists` on a create is **success** — every create is
 *   create-if-absent.
 * - `403` quota denial (the Guardrail `ResourceQuota`) is a **normal branch**:
 *   no Job this pass, no label change, no comment, no `agent:error`.
 */
export class K8sApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "K8sApiError";
  }
}

/** create-if-absent: the object already exists, which is exactly the intended end state. */
export function isAlreadyExists(error: unknown): boolean {
  return error instanceof K8sApiError && error.status === 409;
}

/** Guardrail quota denial — never an `error` outcome (docs/architecture.md §5, spec #33 §8). */
export function isQuotaExceeded(error: unknown): boolean {
  return error instanceof K8sApiError && error.status === 403 && /exceeded quota/i.test(error.message);
}

/** The object is already gone, which is exactly the intent of a delete (reclamation, ADR-0011). */
export function isNotFound(error: unknown): boolean {
  return error instanceof K8sApiError && error.status === 404;
}
