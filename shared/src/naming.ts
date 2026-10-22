/**
 * Deterministic names (spec #33 Implementation Decisions §0):
 * Job `agent-<repo-slug>-<issue#>` (role never in the name), Ticket PVC same
 * name as the Job, per-Job Secret `<job-name>-token`. `repo-slug` is
 * `owner-repo` lowercased, every char outside `[a-z0-9-]` replaced with `-`,
 * truncated to fit the k8s 63-char name budget with the suffix reserved.
 */

/** k8s object names must be ≤ 63 chars (DNS-1123 subdomain names).
 * We keep the whole name (prefix + slug + suffix) inside it. */
export const K8S_NAME_MAX_LENGTH = 63;

export function repoSlug(ownerRepo: string): string {
  return ownerRepo
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
}

/**
 * Suffix appended after the slug for every deterministic object of a ticket:
 * `-<issue#>` (Job / PVC) or `-<issue#>-token` (Secret, the longest name).
 * The Secret is the longest name, so its suffix drives the truncation budget;
 * the Job / PVC therefore fit 63 chars too.
 */
const NAME_SUFFIX_FIXED_PART = "-token";

function slugForBudget(ownerRepo: string, suffix: string): string {
  const prefix = "agent-";
  const budget = K8S_NAME_MAX_LENGTH - prefix.length - suffix.length - NAME_SUFFIX_FIXED_PART.length;
  const slug = repoSlug(ownerRepo);
  return slug.length <= budget ? slug : slug.slice(0, budget);
}

export function jobName(ownerRepo: string, issueNumber: number): string {
  return `agent-${slugForBudget(ownerRepo, `-${issueNumber}`)}-${issueNumber}`;
}

export function secretName(ownerRepo: string, issueNumber: number): string {
  return `${jobName(ownerRepo, issueNumber)}-token`;
}

/** Ticket PVC shares the Job name (one ticket, one Job, one volume). */
export function pvcName(ownerRepo: string, issueNumber: number): string {
  return jobName(ownerRepo, issueNumber);
}
