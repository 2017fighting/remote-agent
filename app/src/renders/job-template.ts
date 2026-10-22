import {
  ANNOTATIONS,
  JOB_ENV_KEYS,
  JOB_MOUNT_PATHS,
  LABELS,
  VOLUME_PATHS,
  jobName,
  secretName,
} from "@remote-agent/shared";
import type { AppConfig } from "../config.js";
import { JOB_IMAGE } from "../job-image.js";
import type { K8sContainer, K8sEnvVar, K8sJobManifest, K8sPvcManifest, K8sVolumeMount } from "../ports/K8sPort.js";

/**
 * Job template (docs/deployment.md §6, ADR-0010): the pod spec is built in App
 * code, not stored as YAML in home-ops, so the image, env surface, volumes and
 * budgets stay in one place with the contract they serve.
 *
 * Deterministic name `agent-<repo-slug>-<issue#>`; the Ticket PVC shares it and
 * the per-Job Secret appends `-token` (ADR-0009).
 */

export type AgentRole = "implement-ticket" | "implement-spec";

/** Both roles run at `high` thinking (docs/deployment.md §9). */
export const AGENT_THINKING_LEVEL = "high";

export const JOB_SERVICE_ACCOUNT = "agent-job";
export const TICKET_PVC_STORAGE_CLASS = "truenas-iscsi-delete";
/** `ReadWriteOncePod` is the single-writer defence (ADR-0008). */
export const TICKET_PVC_ACCESS_MODE = "ReadWriteOncePod";

/** OmniRoute model ids (combo names, docs/deployment.md §9). */
export const OMNIROUTE_DEFAULT_MODEL = "default";
export const OMNIROUTE_REVIEW_MODEL = "review";
/** The one sops secret the Job reads, and the one key it takes from it (never `envFrom`). */
export const OMNIROUTE_API_KEY_SECRET = "remote-agent-secret";

/**
 * Job-side spellings the App emits that are not in the shared key index. #39 moved
 * the clone URL into `JOB_ENV_KEYS` (the Job image owns the Job's env surface), so
 * this alias keeps the one spelling both workspaces read.
 */
export const JOB_ONLY_ENV_KEYS = {
  /** Clone URL the seed clones from: `GIT_BASE_URL/<owner>/<name>.git`, composed by the App. */
  gitRemoteUrl: JOB_ENV_KEYS.gitRemoteUrl,
} as const;

/** Where the per-Job token is mounted as a file (ADR-0009: never env, never a URL). */
export const TOKEN_MOUNT_PATH = "/mnt/credentials/token";

/**
 * The prompt ConfigMap (ADR-0004 / docs/deployment.md §8). The Job image carries
 * no prompt: the runner reads `_common` + its role template from this volume, so
 * changing wording never rebuilds an image.
 */
export const PROMPTS_CONFIGMAP_NAME = "remote-agent-prompts";

/** The single key inside the per-Job token Secret, mounted as the token file. */
export const TOKEN_SECRET_KEY = "token";

/** Code constants, not env overrides (ADR-0010: they follow the image's toolchain). */
export const AGENT_CONTAINER_NAME = "runner";
export const SEED_CONTAINER_NAME = "seed";
export const SEED_FAILURE_EXIT_CODE = 78;
export const TERMINATION_GRACE_PERIOD_SECONDS = 120;
export const POD_FS_GROUP = 1000;

const AGENT_REQUESTS = { cpu: "500m", memory: "2Gi" };
const AGENT_LIMITS = { memory: "6Gi" };
const SEED_REQUESTS = { cpu: "100m", memory: "128Mi" };

export interface JobTemplateInput {
  config: AppConfig;
  targetRepo: string;
  issueNumber: number;
  specNumber: number;
  role: AgentRole;
  /** Serialized AGENT_WORK_ITEM (see renders/work-item.ts). */
  workItemJson: string;
}

export function renderJobManifest(input: JobTemplateInput): K8sJobManifest {
  const { config, targetRepo, issueNumber, specNumber, role } = input;
  const name = jobName(targetRepo, issueNumber);

  return {
    name,
    namespace: config.namespace,
    // Identity goes in the annotations: `owner/name` and `owner/name#n` contain
    // `/` and `#`, which a label value may not carry (the API server answers
    // 422), and slugifying them would lose the repo token renewal mints
    // against. Labels keep only the values k8s accepts (ADR-0011).
    labels: {
      [LABELS.managedBy]: LABELS.managedByValue,
      [LABELS.spec]: String(specNumber),
      [LABELS.role]: role,
    },
    annotations: {
      [ANNOTATIONS.repo]: targetRepo,
      [ANNOTATIONS.ticket]: `${targetRepo}#${issueNumber}`,
    },
    parallelism: 1,
    backoffLimit: config.jobBackoffLimit,
    activeDeadlineSeconds: config.jobActiveDeadlineSeconds,
    ttlSecondsAfterFinished: config.jobTtlSecondsAfterFinished,
    podFailurePolicy: {
      rules: [
        // A non-retryable Seed failure (exit 78) goes terminal immediately
        // instead of grinding through backoffLimit (ADR-0009).
        {
          action: "FailJob",
          onExitCodes: { containerName: SEED_CONTAINER_NAME, operator: "In", values: [SEED_FAILURE_EXIT_CODE] },
        },
      ],
    },
    podTemplate: {
      serviceAccountName: JOB_SERVICE_ACCOUNT,
      // Required by podFailurePolicy: a crash is a new pod, never an in-place restart.
      restartPolicy: "Never",
      terminationGracePeriodSeconds: TERMINATION_GRACE_PERIOD_SECONDS,
      securityContext: { fsGroup: POD_FS_GROUP },
      initContainers: [renderSeedContainer(input)],
      containers: [renderAgentContainer(input)],
      // These three volumes are exactly the three surfaces the Job image reads:
      // the Ticket PVC at /mnt/agent (repo/state/home), the token Secret at its
      // file path, and the prompt ConfigMap at JOB_MOUNT_PATHS.prompts. Adding a
      // volume here without a matching reader in the image (or the reverse) is
      // the drift the kind e2e exists to catch.
      volumes: [
        { name: "ticket", persistentVolumeClaim: { claimName: name } },
        { name: "token", secret: { secretName: secretName(targetRepo, issueNumber) } },
        { name: "prompts", configMap: { name: PROMPTS_CONFIGMAP_NAME } },
      ],
    },
  };
}

function renderSeedContainer(input: JobTemplateInput): K8sContainer {
  const { config, targetRepo, specNumber } = input;
  // Seed only needs to know which repo / branch to put on the volume: it never
  // sees the work item or the model config (ADR-0009, seeding is git only).
  return {
    name: SEED_CONTAINER_NAME,
    image: JOB_IMAGE,
    env: [
      { name: JOB_ENV_KEYS.targetRepo, value: targetRepo },
      { name: JOB_ENV_KEYS.specNumber, value: String(specNumber) },
      { name: JOB_ONLY_ENV_KEYS.gitRemoteUrl, value: gitRemoteUrl(config.gitBaseUrl, targetRepo) },
    ],
    // The seed clones, so it needs the token file too (ADR-0009: both containers
    // mount it as a file, never as env).
    volumeMounts: [...ticketVolumeMounts(), tokenVolumeMount()],
    resources: { requests: SEED_REQUESTS },
  };
}

function renderAgentContainer(input: JobTemplateInput): K8sContainer {
  return {
    name: AGENT_CONTAINER_NAME,
    image: JOB_IMAGE,
    env: renderJobEnv(input),
    // The runner reads the prompt templates from the ConfigMap, so it — and not
    // seed — carries the prompts mount (seed is git only, ADR-0009).
    volumeMounts: [...ticketVolumeMounts(), tokenVolumeMount(), promptsVolumeMount()],
    resources: { requests: AGENT_REQUESTS, limits: AGENT_LIMITS },
  };
}

/**
 * One claim mounted at the layout root: `repo/`, `state/` and `home/` are
 * directories on the same Ticket PVC (ADR-0009). Mounting the root once keeps
 * the three paths from drifting apart between template and image.
 */
function ticketVolumeMounts(): K8sVolumeMount[] {
  return [{ name: "ticket", mountPath: VOLUME_PATHS.mountRoot }];
}

/**
 * The per-Job token as a single file both containers read at git time — never as
 * env (ADR-0009: env is immutable across pod restarts and readable from
 * `kubectl get job -o yaml`).
 */
function tokenVolumeMount(): K8sVolumeMount {
  return { name: "token", mountPath: TOKEN_MOUNT_PATH, subPath: TOKEN_SECRET_KEY, readOnly: true };
}

/**
 * The prompt ConfigMap, one file per key at `JOB_MOUNT_PATHS.prompts` (ADR-0004).
 * The runner's `readPromptFile()` opens `<promptsDir>/<key>`, so the path must be
 * the same constant the Job image reads — importing it is what keeps the two
 * from drifting.
 */
function promptsVolumeMount(): K8sVolumeMount {
  return { name: "prompts", mountPath: JOB_MOUNT_PATHS.prompts, readOnly: true };
}

function renderJobEnv(input: JobTemplateInput): K8sEnvVar[] {
  const { config, targetRepo, issueNumber, specNumber, role } = input;
  const name = jobName(targetRepo, issueNumber);
  return [
    { name: JOB_ENV_KEYS.agentRole, value: role },
    { name: JOB_ENV_KEYS.agentThinkingLevel, value: AGENT_THINKING_LEVEL },
    { name: JOB_ENV_KEYS.agentWorkItem, value: input.workItemJson },
    { name: JOB_ENV_KEYS.targetRepo, value: targetRepo },
    { name: JOB_ENV_KEYS.specNumber, value: String(specNumber) },
    { name: JOB_ENV_KEYS.gitBaseUrl, value: config.gitBaseUrl },
    { name: JOB_ONLY_ENV_KEYS.gitRemoteUrl, value: gitRemoteUrl(config.gitBaseUrl, targetRepo) },
    // Bot identity for agent commits (ADR-0009). Empty is meaningful: the runner
    // then commits as `remote-agent[bot]` without the app id prefix.
    { name: JOB_ENV_KEYS.githubAppId, value: config.githubAppId },
    { name: JOB_ENV_KEYS.omniRouteBaseUrl, value: config.omniRouteBaseUrl },
    { name: JOB_ENV_KEYS.omniRouteModel, value: OMNIROUTE_DEFAULT_MODEL },
    { name: JOB_ENV_KEYS.omniRouteReviewModel, value: OMNIROUTE_REVIEW_MODEL },
    {
      name: JOB_ENV_KEYS.omniRouteApiKey,
      secretKeyRef: { name: OMNIROUTE_API_KEY_SECRET, key: JOB_ENV_KEYS.omniRouteApiKey },
    },
    // The runner writes its run result on its own Job (ADR-0007), so it needs
    // both identifiers. They come from different sources on purpose:
    //
    // `JOB_NAMESPACE` is the pod's own namespace, which the downward API reports.
    //
    // `JOB_NAME` is a literal, **not** `fieldRef: metadata.name`: in a container
    // the downward API resolves `metadata.name` to the *pod* name, and a Job's
    // pod is `<job-name>-<random5>`. `deriveJobName()` in the runner prefers
    // `JOB_NAME` from env over the deterministic rule, so a pod name here would
    // make every run-result PATCH target a Job that does not exist (404) and the
    // App would judge each run `error`. The App already knows the one right
    // value — the same `jobName()` rule the manifest's `metadata.name` uses.
    { name: JOB_ENV_KEYS.jobName, value: name },
    { name: JOB_ENV_KEYS.jobNamespace, valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
  ];
}

/** `GIT_BASE_URL/<owner>/<name>.git` — a clean URL, never carrying the token (ADR-0009). */
export function gitRemoteUrl(gitBaseUrl: string, targetRepo: string): string {
  return `${gitBaseUrl.replace(/\/+$/, "")}/${targetRepo}.git`;
}

/** Ticket PVC create payload (ADR-0010 / ADR-0011). */
export function renderTicketPvc(input: {
  config: AppConfig;
  targetRepo: string;
  issueNumber: number;
  specNumber: number;
}): K8sPvcManifest {
  const { config, targetRepo, issueNumber, specNumber } = input;
  return {
    name: jobName(targetRepo, issueNumber),
    namespace: config.namespace,
    annotations: {
      [ANNOTATIONS.repo]: targetRepo,
      [ANNOTATIONS.ticket]: `${targetRepo}#${issueNumber}`,
    },
    labels: {
      [LABELS.managedBy]: LABELS.managedByValue,
      [LABELS.spec]: String(specNumber),
    },
    spec: {
      accessModes: [TICKET_PVC_ACCESS_MODE],
      storageClassName: TICKET_PVC_STORAGE_CLASS,
      resources: { requests: { storage: config.jobPvcSize } },
    },
  };
}
