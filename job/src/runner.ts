import { pathToFileURL } from "node:url";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  readRunnerEnv,
  readServiceAccountNamespace,
  requireEnv,
  REQUIRED_RUNNER_ENV_KEYS,
  StartupError,
  jobPaths,
  type RunnerEnv,
} from "./internal/env.js";
import { createOmniRouteModels } from "./internal/provider.js";
import { inClusterAnnotationWriter } from "./internal/annotation.js";
import { RUNNER_EXIT } from "@remote-agent/shared";
import { pushExitCodeFor, pushToSpecBranch, run, type RunOutcome } from "./internal/runner.js";

export interface RunnerEntryOptions {
  env?: Record<string, string | undefined>;
  /** Overrides the ServiceAccount namespace file; the kubelet always provides it in-cluster. */
  namespace?: string;
  log?(line: string): void;
}

/**
 * Main container entry (spec #33 §6). Every required env key is validated before
 * any durable storage is opened, so a broken Job template fails the pod at once
 * instead of at the first model request.
 */
export async function runRunner(options: RunnerEntryOptions = {}): Promise<RunOutcome> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  // Validate the env before any I/O: a broken Job template must fail on its own
  // error, not on a missing ServiceAccount mount it would never have needed.
  requireEnv(env, REQUIRED_RUNNER_ENV_KEYS);
  const namespace = options.namespace ?? (await readServiceAccountNamespace());
  const runnerEnv: RunnerEnv = readRunnerEnv(env, namespace);
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
      const exitCode = pushExitCodeFor(error);
      console.error(
        `run-failed${error instanceof StartupError ? " startup=true" : ""}` +
          `${exitCode === RUNNER_EXIT.fatal ? " fatal=true" : ""} detail=${detail}`,
      );
      // Nonzero and no annotation: k8s starts a new pod, which resumes to the end
      // and pushes again (ADR-0009). `RUNNER_EXIT.fatal` is the exception — a
      // failure no later pod can fix, which `podFailurePolicy` turns into FailJob
      // at once (#55).
      process.exit(exitCode);
    },
  );
}
