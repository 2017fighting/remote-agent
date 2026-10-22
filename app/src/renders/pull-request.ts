import type { GitHubIssue } from "../ports/GitHubPort.js";

/**
 * Closeout PR body (docs/architecture.md §4.5 S3, ADR-0002). The App opens the
 * PR — the agent never touches GitHub — so the `Closes` trailer cannot come from
 * a commit message: it is appended here, one line of its own.
 *
 * The append is idempotent in the body itself, not only in the PR object: a
 * `prBody` that already carries the trailer (the agent wrote it, or this ran
 * before) is returned untouched, so no pass can produce a second `Closes`.
 */

export const CLOSEOUT_PR_BASE_BRANCH = "main";

export function closesLine(specNumber: number): string {
  return `Closes #${specNumber}`;
}

export function renderCloseoutPrBody(prBody: string, specNumber: number): string {
  if (hasClosesLine(prBody, specNumber)) return prBody;
  const trimmed = prBody.trimEnd();
  return trimmed === "" ? closesLine(specNumber) : [trimmed, "", closesLine(specNumber)].join("\n");
}

/**
 * A line of its own, so `Closes #33` never matches a body that closes `#338`
 * and a `Closes #33` embedded in prose is not mistaken for the trailer.
 */
function hasClosesLine(body: string, specNumber: number): boolean {
  return new RegExp(`^\\s*Closes\\s+#${specNumber}\\s*$`, "m").test(body);
}

/** Title = the spec issue's own title: the PR delivers the spec, it is not a new document. */
export function renderCloseoutPrTitle(spec: GitHubIssue): string {
  return spec.title;
}
