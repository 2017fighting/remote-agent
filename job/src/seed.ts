import { statfs } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { jobPaths, readSeedEnv, StartupError } from "./internal/env.js";
import { seed } from "./internal/seed.js";

/**
 * Init container entry (ADR-0009): seed the Ticket PVC's worktree once, then exit.
 * `podFailurePolicy` reads the exit code, so 75 (retryable) and 78 (fatal) are the
 * only two failure exits.
 */
export async function runSeed(env: Record<string, string | undefined> = process.env): Promise<number> {
  const log = (line: string) => console.log(line);
  let seedEnv;
  try {
    seedEnv = readSeedEnv(env);
  } catch (error) {
    if (error instanceof StartupError) {
      // A Job template that cannot even describe the repo is as fatal as a bad
      // credential: no amount of retrying fixes it.
      log(`seed-failed kind=unknown detail=${error.message}`);
      return 78;
    }
    throw error;
  }
  const paths = jobPaths();
  const outcome = await seed({
    env: seedEnv,
    paths,
    log,
    freeBytes: async (path) => {
      const stats = await statfs(path);
      return stats.bavail * stats.bsize;
    },
  });
  return outcome.exitCode;
}

const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (invokedDirectly) {
  runSeed().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`seed-failed kind=unknown detail=${error instanceof Error ? error.message : String(error)}`);
      process.exit(78);
    },
  );
}
