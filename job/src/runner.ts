import { pathToFileURL } from "node:url";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { jobPaths, readRunnerEnv, StartupError, type RunnerEnv } from "./internal/env.js";
import { createOmniRouteModels } from "./internal/provider.js";
import { inClusterAnnotationWriter } from "./internal/annotation.js";
import { pushToSpecBranch, run, type RunOutcome } from "./internal/runner.js";

/**
 * Main container entry (spec #33 §6). Every required env key is validated before
 * any durable storage is opened, so a broken Job template fails the pod at once
 * instead of at the first model request.
 */
export async function runRunner(env: Record<string, string | undefined> = process.env): Promise<RunOutcome> {
  const log = (line: string) => console.log(line);
  const runnerEnv: RunnerEnv = readRunnerEnv(env);
  const paths = jobPaths();
  const models = createOmniRouteModels(runnerEnv.omniRoute);
  const writer = inClusterAnnotationWriter(env, runnerEnv, log);

  return run({
    env: runnerEnv,
    paths,
    models,
    log,
    openStorage: (path) => openNodeSqliteStorage(path),
    annotate: (result) => writer.write(result),
    push: () => pushToSpecBranch({ env: runnerEnv, paths, log }),
  });
}

const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (invokedDirectly) {
  runRunner().then(
    (outcome) => process.exit(outcome.exitCode),
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`run-failed${error instanceof StartupError ? " startup=true" : ""} detail=${detail}`);
      // Nonzero and no annotation: k8s starts a new pod, which resumes to the end
      // and pushes again (ADR-0009).
      process.exit(1);
    },
  );
}
