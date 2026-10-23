import { stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Candidate names for "how code should be written" files (spec #33 §6, A17a).
 * The table is a constant of the image; the scan runs against the working copy
 * the reviewer is about to read, so it never goes stale against a target repo.
 * `CODING_STANDARDS.md` and `CONTRIBUTING.md` are always in it.
 */
export const STANDARDS_FILE_CANDIDATES = [
  "CODING_STANDARDS.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "docs/CODING_STANDARDS.md",
  "docs/CONTRIBUTING.md",
] as const;

/** The existing candidate files, in table order; empty when the repo has none. */
export async function findStandardsFiles(repo: string): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of STANDARDS_FILE_CANDIDATES) {
    if (await isFile(join(repo, candidate))) found.push(candidate);
  }
  return found;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
