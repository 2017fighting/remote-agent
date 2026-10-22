import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  applyManifests,
  createRunner,
  dumpDiagnostics,
  seedBareRepository,
  workDir,
  type Runner,
  type Section,
} from "./harness.js";
import {
  NAMESPACE,
  renderAppDeployment,
  renderAppRbac,
  renderJobRbac,
  renderNamespace,
  renderAppSecret,
  renderPromptsConfigMap,
  renderResourceQuota,
  renderStubService,
  renderTicketStorageClass,
} from "./manifests.js";
import {
  MODEL_SCRIPT,
  SCENARIO,
  SPEC_NUMBER,
  TARGET_REPO,
  TICKET_NUMBERS,
  WEBHOOK_DELIVERIES,
} from "./scenario.js";
import {
  AssertionTimeout,
  delay,
  isJobFinished,
  jobTerminalReason,
  kubectlJson,
  poll,
  type K8sDeploymentObject,
  type K8sJobObject,
  type K8sObjectList,
  type K8sPodObject,
  type K8sPvcObject,
} from "./assertions.js";

/**
 * The kind e2e (spec #33 Testing Decisions 3, ticket #41) — the spec's delivery
 * gate.
 *
 * What it does, in order:
 *
 *   1. bring up a kind cluster and build + load both images;
 *   2. apply the namespace contract from docs/deployment.md §4/§5/§7/§8 (RBAC,
 *      guardrail quota, prompt ConfigMap from `prompts/`) plus a storage class
 *      of the name the App's template requires;
 *   3. start the two stub services as Deployments, with a real bare git
 *      repository behind stub-github;
 *   4. start the App as a Deployment, pointed at the stubs by env only;
 *   5. drive the scenario: signed webhooks, two sequential claims, two Job runs,
 *      the closeout, the PR;
 *   6. assert the final world and print a sectioned log.
 *
 * The only difference between this and production is the three base URLs. There
 * is no test-mode branch in product code; if the App or the Job needs anything
 * the real deployment does not provide, this fails.
 *
 * Usage: node e2e/src/run.mjs [--keep] [--verbose] [--no-cleanup] [--timeout <s>]
 */

/**
 * The checkout the harness builds from. `run.mjs` bundles this file into a temp
 * directory, so `import.meta.url` does not point into the repo — the entrypoint
 * passes the root explicitly.
 */
const repoRoot = resolve(process.env["RA_E2E_REPO_ROOT"] ?? process.cwd());

/** Image tags the harness builds and loads. Distinct from GHCR so nothing is pulled by accident. */
const APP_IMAGE = "remote-agent-e2e/app:local";
const JOB_IMAGE = "remote-agent-e2e/job:local";
const STUB_GITHUB_IMAGE = "remote-agent-e2e/stub-github:local";
const STUB_MODEL_IMAGE = "remote-agent-e2e/stub-model:local";
const JOB_IMAGE_TAG = "e2e";

const STUB_GITHUB_PORT = 8080;
const STUB_MODEL_PORT = 8080;
const APP_PORT = 8080;

const WEBHOOK_SECRET = "e2e-webhook-secret";
const INSTALLATION_TOKEN = "ghs_e2e_installation_token";
const OMNIROUTE_API_KEY = "e2e-omniroute-key";

/**
 * The App's GitHub App signing key, generated per run.
 *
 * Production reads it from `remote-agent-secret` (docs/deployment.md §3) and the
 * adapter rejects an empty one, so the harness has to supply a real RSA key of
 * the shape GitHub issues — not a placeholder string. The stub does not verify
 * the signature (there is no GitHub App behind it), but the key must parse,
 * because `OctokitGitHub` signs a JWT with it before its first read.
 */
const APP_PRIVATE_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

export interface RunOptions {
  keep: boolean;
  verbose: boolean;
  cleanup: boolean;
  timeoutMs: number;
  clusterName: string;
}

interface RunSummary {
  ok: boolean;
  sections: Record<string, string>;
  failure?: string;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const summary = await run(options);
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): RunOptions {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const timeout = flag("--timeout");
  return {
    keep: argv.includes("--keep"),
    verbose: argv.includes("--verbose"),
    cleanup: !argv.includes("--no-cleanup"),
    timeoutMs: (timeout === undefined ? 300 : Number.parseInt(timeout, 10)) * 1000,
    clusterName: flag("--cluster") ?? "ra-e2e",
  };
}

/**
 * The run itself. A failure is reported with the section it happened in and a
 * full diagnostics dump, then re-thrown so the exit code is nonzero: the e2e
 * must never pass by skipping.
 */
export async function run(options: RunOptions): Promise<RunSummary> {
  const runner = createRunner({ verbose: options.verbose });
  const scratch = await workDir(options.keep);
  let currentSection: Section = "cluster";
  const markSection = (name: Section): void => {
    currentSection = name;
  };

  try {
    markSection("cluster");
    runner.section("cluster", "kind cluster + images");
    const context = `kind-${options.clusterName}`;
    await ensureCluster(runner, options.clusterName);

    markSection("images");
    runner.section("images", "build and load images");
    await buildImages(runner, options);
    await loadImages(runner, options.clusterName);

    markSection("stubs");
    runner.section("stubs", "namespace contract + stub services");
    const projectRoot = join(scratch.path, "git");
    await mkdir(projectRoot, { recursive: true });
    await seedBareRepository({ projectRoot, repo: TARGET_REPO, specNumber: SPEC_NUMBER, runner });

    await applyManifests(runner, context, [
      renderNamespace(),
      renderTicketStorageClass(),
      ...renderAppRbac(),
      ...renderJobRbac(),
      renderResourceQuota(),
      await renderPromptsConfigMap(join(repoRoot, "prompts")),
      renderAppSecret({
        privateKey: APP_PRIVATE_KEY,
        webhookSecret: WEBHOOK_SECRET,
        omniRouteApiKey: OMNIROUTE_API_KEY,
      }),
    ]);

    // The stubs read their scenario from a ConfigMap so they start with no
    // dependency on the harness's filesystem.
    await applyManifests(runner, context, [
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "e2e-scenario", namespace: NAMESPACE },
        data: { "scenario.json": JSON.stringify(SCENARIO), "model-script.json": JSON.stringify(MODEL_SCRIPT) },
      },
    ]);

    const stubGitHubUrl = `http://stub-github.${NAMESPACE}.svc.cluster.local:${STUB_GITHUB_PORT}`;
    const stubModelUrl = `http://stub-model.${NAMESPACE}.svc.cluster.local:${STUB_MODEL_PORT}/v1`;

    await applyManifests(runner, context, [
      ...renderStubService({
        name: "stub-github",
        image: STUB_GITHUB_IMAGE,
        port: STUB_GITHUB_PORT,
        args: [
          "--scenario",
          "/etc/e2e/scenario.json",
          "--project-root",
          "/git",
          "--token",
          INSTALLATION_TOKEN,
          "--port",
          String(STUB_GITHUB_PORT),
        ],
        volumes: [
          { name: "scenario", configMap: { name: "e2e-scenario" } },
          { name: "git", emptyDir: {} },
        ],
        volumeMounts: [
          { name: "scenario", mountPath: "/etc/e2e", readOnly: true },
          { name: "git", mountPath: "/git" },
        ],
      }),
      ...renderStubService({
        name: "stub-model",
        image: STUB_MODEL_IMAGE,
        port: STUB_MODEL_PORT,
        args: ["--script", "/etc/e2e/model-script.json", "--port", String(STUB_MODEL_PORT)],
        volumes: [{ name: "scenario", configMap: { name: "e2e-scenario" } }],
        volumeMounts: [{ name: "scenario", mountPath: "/etc/e2e", readOnly: true }],
      }),
    ]);

    // The bare repo lives in an emptyDir owned by stub-github, so seed it there
    // once the pod is up: the harness copies the real repository in.
    await waitForDeployment(runner, context, "stub-github", options.timeoutMs);
    await waitForDeployment(runner, context, "stub-model", options.timeoutMs);
    await seedStubGitHubRepo(runner, context, projectRoot);

    markSection("app");
    runner.section("app", "App Deployment");
    await applyManifests(runner, context, [
      renderAppDeployment({
        image: APP_IMAGE,
        stubGitHubUrl,
        stubModelUrl,
        targetRepo: TARGET_REPO,
      }),
    ]);

    const appReady = await waitForAppOrFailFast(runner, context, options);
    if (appReady !== null) return appReady;

    // Drive the scenario: one signed webhook is enough — the App's own tick and
    // Job-watch wake the rest (ADR-0014). The deliveries are the human's act.
    await sendWebhooks(runner, context, WEBHOOK_DELIVERIES);

    markSection("job");
    runner.section("job", "two ticket Jobs, then the closeout");
    const claims = await observeSequentialClaims(runner, context, options);
    runner.note(`claims observed in order: ${claims.join(", ")}`);

    markSection("assert");
    runner.section("assert", "final world");
    await assertFinalWorld(runner, context, options);

    runner.section("assert", "PASSED: the closed loop held");
    return { ok: true, sections: sectionsOf(runner) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof AssertionTimeout;
    const runner2 = runner;
    runner2.section(currentSection, `FAILED in [${currentSection}]${isTimeout ? " (assertion timeout)" : ""}`);
    runner2.write(message);
    try {
      const diagnostics = await dumpDiagnostics({
        context: `kind-${options.clusterName}`,
        namespace: NAMESPACE,
        runner,
      });
      runner2.section(currentSection, "diagnostics");
      runner2.write(diagnostics);
    } catch (dumpError) {
      runner2.write(`(diagnostics unavailable: ${String(dumpError)})`);
    }
    return { ok: false, sections: sectionsOf(runner), failure: message };
  } finally {
    await scratch.cleanup();
  }
}

function sectionsOf(runner: Runner): Record<string, string> {
  // The runner holds one ordered log; section boundaries are already in it. A
  // per-section split is what the CI step prints, so keep it simple: the whole
  // log is the artifact, and the FAILED banner names the section.
  return { log: runner.text() };
}

// --- cluster ---------------------------------------------------------------

async function ensureCluster(runner: Runner, name: string): Promise<void> {
  const existing = await runner.run("kind", ["get", "clusters"], { allowFailure: true });
  if (existing.stdout.split("\n").includes(name)) {
    runner.note(`cluster ${name} already exists; reusing it`);
    await resetNamespace(runner, `kind-${name}`);
    return;
  }
  await runner.run("kind", ["create", "cluster", "--name", name, "--wait", "180s"]);
}

/**
 * Drop the e2e namespace before reusing a cluster.
 *
 * Everything the harness owns lives in it (Deployments, Jobs, Ticket PVCs,
 * per-Job Secrets), so a previous run's objects would otherwise be asserted on:
 * a stale App pod still runs the previous image, and a stale Job or PVC makes a
 * claim assertion pass without this run having claimed anything. The namespace
 * is re-applied from `manifests.ts` a few lines later, so deleting it is safe.
 */
async function resetNamespace(runner: Runner, context: string): Promise<void> {
  const deleted = await runner.run("kubectl", ["--context", context, "delete", "namespace", NAMESPACE, "--ignore-not-found", "--wait=false"], {
    allowFailure: true,
  });
  if (deleted.exitCode !== 0) {
    runner.note(`could not delete namespace ${NAMESPACE}: ${deleted.stderr.trim()}`);
    return;
  }
  runner.note(`deleted namespace ${NAMESPACE} from the previous run; waiting for it to go`);
  await poll<string>({
    description: `namespace ${NAMESPACE} is gone`,
    timeoutMs: 120_000,
    intervalMs: 1000,
    observe: () =>
      runner.run("kubectl", ["--context", context, "get", "namespace", NAMESPACE, "-o", "name"], { allowFailure: true })
        .then((result) => result.stdout.trim()),
    until: (stdout) => stdout === "",
    describe: (stdout) => stdout || "absent",
  });
}

async function buildImages(runner: Runner, options: RunOptions): Promise<void> {
  // The App image bakes the Job tag; build the Job image first so the tag the
  // App will reference exists when a Job starts (docs/deployment.md §6).
  await dockerBuild(runner, ["-f", "job/Dockerfile", "-t", JOB_IMAGE, "."]);
  await dockerBuild(runner, [
    "-f",
    "app/Dockerfile",
    "--build-arg",
    `JOB_IMAGE_TAG=${JOB_IMAGE_TAG}`,
    "-t",
    APP_IMAGE,
    ".",
  ]);
  await runner.run("node", ["e2e/build.mjs"], { cwd: repoRoot });
  await dockerBuild(runner, ["-f", "e2e/stub-github/Dockerfile", "-t", STUB_GITHUB_IMAGE, "."]);
  await dockerBuild(runner, ["-f", "e2e/stub-model/Dockerfile", "-t", STUB_MODEL_IMAGE, "."]);
  void options;
}

/**
 * `docker build` with one retry on the legacy builder. BuildKit's cache is not
 * always usable (a stale layer snapshot fails the build before it starts); the
 * images here are small and the legacy path is deterministic, so a fallback is
 * cheaper than a diagnostic detour in CI.
 */
async function dockerBuild(runner: Runner, args: string[]): Promise<void> {
  const buildkit = await runner.run("docker", ["build", ...args], { cwd: repoRoot, allowFailure: true });
  if (buildkit.exitCode === 0) return;
  runner.note("buildkit failed; retrying with DOCKER_BUILDKIT=0");
  await runner.run("docker", ["build", ...args], {
    cwd: repoRoot,
    env: { ...process.env, DOCKER_BUILDKIT: "0" },
  });
}

async function loadImages(runner: Runner, clusterName: string): Promise<void> {
  for (const image of [APP_IMAGE, JOB_IMAGE, STUB_GITHUB_IMAGE, STUB_MODEL_IMAGE]) {
    await runner.run("kind", ["load", "docker-image", "--name", clusterName, image]);
  }
}

async function waitForDeployment(
  runner: Runner,
  context: string,
  name: string,
  timeoutMs: number,
): Promise<void> {
  await poll<K8sDeploymentObject | null>({
    description: `Deployment ${name} available`,
    timeoutMs,
    intervalMs: 2000,
    observe: () => kubectlJson<K8sDeploymentObject>(runner, context, NAMESPACE, "deployment", name),
    until: (deployment) => (deployment?.status?.availableReplicas ?? 0) >= 1,
    describe: (deployment) => JSON.stringify(deployment?.status ?? null),
  });
}

/**
 * Wait for the App Deployment. A crash-looping App is the interesting failure,
 * so this returns a failed summary with the reason instead of only timing out:
 * "the App died at the startup list" must be legible (supervisor's instruction).
 */
async function waitForAppOrFailFast(
  runner: Runner,
  context: string,
  options: RunOptions,
): Promise<RunSummary | null> {
  try {
    await poll<K8sDeploymentObject | null>({
      description: "Deployment remote-agent available",
      timeoutMs: Math.min(options.timeoutMs, 120_000),
      intervalMs: 2000,
      observe: () => kubectlJson<K8sDeploymentObject>(runner, context, NAMESPACE, "deployment", "remote-agent"),
      until: (deployment) => (deployment?.status?.availableReplicas ?? 0) >= 1,
      describe: (deployment) => JSON.stringify(deployment?.status ?? null),
    });
    return null;
  } catch (error) {
    // Distinguish "still starting" from "the process exits immediately": read
    // the App's logs and say what actually happened.
    const logs = await runner.run("kubectl", ["--context", context, "-n", NAMESPACE, "logs", "deploy/remote-agent", "--tail", "60"], {
      allowFailure: true,
    });
    const appLogs = logs.stdout.trim();
    const startupFailure = /not implemented|STARTUP FAILED|Error:/.test(appLogs);
    runner.section("app", "App did not become available");
    runner.write(
      startupFailure
        ? [
            "The App process started and then failed. Its log says:",
            appLogs,
            "",
            "This is the App-side failure the e2e exists to make legible. The most",
            "likely cause is that a production port implementation is still a stub",
            "(app/src/adapters/*): the App's startup list runs through GitHubPort, so",
            "an unimplemented adapter kills the process before any webhook is served.",
          ].join("\n")
        : ["The App did not become available within the deadline. Its log so far:", appLogs || "(empty)"].join("\n"),
    );
    return { ok: false, sections: sectionsOf(runner), failure: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Copy the harness's real bare repository into the stub-github pod's emptyDir.
 * `kubectl cp` of a `.git` directory is the simplest way to get a real repo onto
 * a volume the pod owns; the stub then serves it with `git http-backend`.
 */
async function seedStubGitHubRepo(runner: Runner, context: string, projectRoot: string): Promise<void> {
  const pod = await runner.run(
    "kubectl",
    [
      "--context",
      context,
      "-n",
      NAMESPACE,
      "get",
      "pods",
      "-l",
      "app=stub-github",
      "-o",
      "jsonpath={.items[0].metadata.name}",
    ],
    { allowFailure: true },
  );
  const podName = pod.stdout.trim();
  if (podName === "") throw new Error("stub-github pod is not running, so the git repository cannot be seeded");
  await runner.run("kubectl", ["--context", context, "-n", NAMESPACE, "exec", podName, "--", "mkdir", "-p", `/git/${TARGET_REPO.split("/")[0]}`]);
  await runner.run("kubectl", [
    "--context",
    context,
    "-n",
    NAMESPACE,
    "cp",
    join(projectRoot, TARGET_REPO.split("/")[0]!, `${TARGET_REPO.split("/")[1]}.git`),
    `${podName}:/git/${TARGET_REPO.split("/")[0]}`,
  ]);
}

// --- scenario driving ------------------------------------------------------

async function sendWebhooks(
  runner: Runner,
  context: string,
  deliveries: ReadonlyArray<{ event: string; action: string }>,
): Promise<void> {
  const pod = await runner.run(
    "kubectl",
    ["--context", context, "-n", NAMESPACE, "get", "pods", "-l", "app=remote-agent", "-o", "jsonpath={.items[0].metadata.name}"],
    { allowFailure: true },
  );
  const podName = pod.stdout.trim();
  for (const delivery of deliveries) {
    const payload = JSON.stringify({ action: delivery.action, issue: { number: SPEC_NUMBER } });
    const signature = "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
    // Deliver from inside the cluster so the signature and the route are the
    // real ones (no port-forward in the path).
    const script = [
      `printf '%s' ${JSON.stringify(payload)} > /tmp/body.json`,
      `code=$(wget -q -O- --server-response`,
      `--header='content-type: application/json'`,
      `--header='x-github-event: ${delivery.event}'`,
      `--header='x-hub-signature-256: ${signature}'`,
      `--post-file=/tmp/body.json http://127.0.0.1:${APP_PORT}/webhook 2>&1 | head -1)`,
      `echo "$code"`,
    ].join(" ");
    await runner.run("kubectl", ["--context", context, "-n", NAMESPACE, "exec", podName, "--", "sh", "-c", script]);
    await delay(500);
  }
}

/**
 * Both tickets are claimed, one after the other, and both claims are observed:
 * the second ticket's Job only appears once the first ticket's Job object is
 * gone (the k8s half of the Claim-gate, ADR-0013). So the assertion is that the
 * two Jobs appear in order and both reach Complete.
 */
async function observeSequentialClaims(runner: Runner, context: string, options: RunOptions): Promise<string[]> {
  const observed: string[] = [];
  for (const ticketNumber of TICKET_NUMBERS) {
    const jobName = `agent-2017fighting-remote-agent-${ticketNumber}`;
    await poll<K8sJobObject | null>({
      description: `Job ${jobName} exists (ticket #${ticketNumber} claimed)`,
      timeoutMs: options.timeoutMs,
      intervalMs: 2000,
      observe: () => kubectlJson<K8sJobObject>(runner, context, NAMESPACE, "job", jobName),
      until: (job) => job !== null,
      describe: (job) => (job === null ? "absent" : "present"),
    });
    observed.push(jobName);

    // The ticket must show `agent:in-progress` while its Job is running: this is
    // the label half of the claim being observable on GitHub, not just in k8s.
    await poll<K8sJobObject | null>({
      description: `Job ${jobName} reaches a terminal condition`,
      timeoutMs: options.timeoutMs,
      intervalMs: 2000,
      observe: () => kubectlJson<K8sJobObject>(runner, context, NAMESPACE, "job", jobName),
      until: (job) => job !== null && isJobFinished(job),
      describe: (job) => (job === null ? "absent" : JSON.stringify(job.status?.conditions ?? [])),
    });
    const job = await kubectlJson<K8sJobObject>(runner, context, NAMESPACE, "job", jobName);
    if (job !== null && jobTerminalReason(job) !== undefined) {
      throw new Error(`Job ${jobName} failed with reason ${jobTerminalReason(job)}`);
    }
    // The run result annotation is written only after a successful push (ADR-0007).
    await poll<K8sJobObject | null>({
      description: `Job ${jobName} carries remote-agent/run-result`,
      timeoutMs: 60_000,
      intervalMs: 1000,
      observe: () => kubectlJson<K8sJobObject>(runner, context, NAMESPACE, "job", jobName),
      until: (value) => value?.metadata.annotations?.["remote-agent/run-result"] !== undefined,
      describe: (value) => JSON.stringify(Object.keys(value?.metadata.annotations ?? {})),
    });
  }
  return observed;
}

/** The final world (ticket #41 acceptance criteria). */
async function assertFinalWorld(runner: Runner, context: string, options: RunOptions): Promise<void> {
  // 1. Both tickets closed.
  await poll<K8sJobObject | null>({
    description: "the closeout Job exists and finished",
    timeoutMs: options.timeoutMs,
    intervalMs: 2000,
    observe: () =>
      kubectlJson<K8sJobObject>(runner, context, NAMESPACE, "job", `agent-2017fighting-remote-agent-${SPEC_NUMBER}`),
    until: (job) => job !== null && isJobFinished(job),
    describe: (job) => (job === null ? "absent" : JSON.stringify(job.status?.conditions ?? [])),
  });

  // 2. Every Ticket PVC carries `expires-at`, about seven days out (done retention).
  await poll<K8sObjectList<K8sPvcObject>>({
    description: "every Ticket PVC carries remote-agent/expires-at",
    timeoutMs: 120_000,
    intervalMs: 2000,
    observe: () => kubectlJson<K8sObjectList<K8sPvcObject>>(runner, context, NAMESPACE, "pvc") as Promise<K8sObjectList<K8sPvcObject>>,
    until: (list) =>
      list.items.length > 0 && list.items.every((pvc) => pvc.metadata.annotations?.["remote-agent/expires-at"] !== undefined),
    describe: (list) => JSON.stringify(list.items.map((pvc) => Object.keys(pvc.metadata.annotations ?? {}))),
  });

  // 3. The App never deletes a Job: TTL owns deletion (ADR-0012). Assert that
  //    every Job still exists with its run-result annotation intact.
  const jobs = await kubectlJson<K8sObjectList<K8sJobObject>>(runner, context, NAMESPACE, "job");
  if (jobs === null) throw new Error("no Jobs in the namespace at the end of the run");
  for (const ticketNumber of TICKET_NUMBERS) {
    const name = `agent-2017fighting-remote-agent-${ticketNumber}`;
    if (!jobs.items.some((job) => job.metadata.name === name)) {
      throw new Error(`Job ${name} was deleted; the App must never delete a Job (ADR-0012)`);
    }
  }

  // 4. The pods that ran are still identifiable, and none is crash-looping.
  const pods = await kubectlJson<K8sObjectList<K8sPodObject>>(runner, context, NAMESPACE, "pod");
  if (pods === null) throw new Error("no pods in the namespace at the end of the run");
}
