import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The kind namespace's manifests (docs/deployment.md §1/§4/§5/§7/§8).
 *
 * These are the harness's own copies, not home-ops': the point is to reproduce
 * the deployed *contract* — the namespace, the two ServiceAccounts with exactly
 * the permissions the docs grant, the guardrail quota, and the optional prompt
 * override ConfigMap — so the e2e exercises the same permission surface the real
 * deployment has. The prompt override is the incident hatch (ADR-0020): the
 * harness creates it with only `_common`, and the run must log
 * `prompt-source=_common:override` with every other key `:image`. A missing RBAC
 * verb here fails the same way it would in production, which is what makes the
 * gate meaningful.
 *
 * Everything the harness adds beyond the docs is e2e-only and stays in this
 * file: the stub services and their Service, and the App's env pointing at them.
 */

export const NAMESPACE = "remote-agent";
export const APP_SERVICE_ACCOUNT = "remote-agent";
export const JOB_SERVICE_ACCOUNT = "agent-job";
/** The optional incident override ConfigMap the Job template mounts (ADR-0020). */
export const PROMPTS_OVERRIDE_CONFIGMAP = "remote-agent-prompts-override";
/**
 * The one key the harness's incident override carries (ADR-0020). One key is
 * enough: the point is the per-key *source* the run logs, so the run must report
 * `_common:override` and fall back to the image for the other four. This is the
 * single spelling the fixture and the log assertion share.
 */
export const PROMPTS_OVERRIDE_KEY = "_common";
/** The one sops-equivalent Secret (docs/deployment.md §3); the App and the Job both read it. */
export const APP_SECRET = "remote-agent-secret";

/**
 * The prompt override ConfigMap, with only `_common` (ADR-0020). An operator
 * creates this by hand in an incident; the harness does the same so the wired
 * hatch is exercised end to end. Its content is an operator's hot-edit, so the
 * evidence is the run's `prompt-source=_common:override` line, not a comparison
 * against `prompts/` (that comparison lives once, in the Job's unit tests).
 */
export async function renderPromptsOverrideConfigMap(promptsDir: string): Promise<Record<string, unknown>> {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: PROMPTS_OVERRIDE_CONFIGMAP, namespace: NAMESPACE },
    data: { [PROMPTS_OVERRIDE_KEY]: await readFile(join(promptsDir, PROMPTS_OVERRIDE_KEY), "utf8") },
  };
}

export function renderNamespace(): Record<string, unknown> {
  return { apiVersion: "v1", kind: "Namespace", metadata: { name: NAMESPACE } };
}

/**
 * The Ticket PVC's storage class (ADR-0010). The App's template hardcodes
 * `truenas-iscsi-delete` — that name is the home cluster's, and the App must not
 * learn about a second one. kind has no such class, so the harness supplies a
 * class of that name backed by kind's own `rancher.io/local-path` provisioner.
 *
 * This is the one place the harness adapts the cluster to the product rather
 * than the product to the test: the PVC still binds, mounts and shares the
 * ReadWriteOncePod semantics, so the Job sees a real volume.
 */
export function renderTicketStorageClass(): Record<string, unknown> {
  return {
    apiVersion: "storage.k8s.io/v1",
    kind: "StorageClass",
    metadata: { name: "truenas-iscsi-delete" },
    provisioner: "rancher.io/local-path",
    reclaimPolicy: "Delete",
    volumeBindingMode: "WaitForFirstConsumer",
  };
}

/**
 * App RBAC (docs/deployment.md §4), verbatim: jobs create/get/list/watch,
 * pods get/list, pods/log get, secrets create/get/patch/delete, PVCs
 * create/get/list/patch/delete. Deliberately absent: jobs delete/patch (k8s is
 * the only Job deleter, ADR-0012) and pods/exec. If the App ever needed one of
 * those, the e2e would fail with a 403 — that is the assertion.
 */
export function renderAppRbac(): Record<string, unknown>[] {
  return [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: APP_SERVICE_ACCOUNT, namespace: NAMESPACE },
      automountServiceAccountToken: true,
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name: APP_SERVICE_ACCOUNT, namespace: NAMESPACE },
      rules: [
        { apiGroups: ["batch"], resources: ["jobs"], verbs: ["create", "get", "list", "watch"] },
        { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
        { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
        { apiGroups: [""], resources: ["secrets"], verbs: ["create", "get", "patch", "delete"] },
        {
          apiGroups: [""],
          resources: ["persistentvolumeclaims"],
          verbs: ["create", "get", "list", "patch", "delete"],
        },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: APP_SERVICE_ACCOUNT, namespace: NAMESPACE },
      subjects: [{ kind: "ServiceAccount", name: APP_SERVICE_ACCOUNT, namespace: NAMESPACE }],
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: APP_SERVICE_ACCOUNT },
    },
  ];
}

/**
 * Job RBAC (docs/deployment.md §5): the shared `agent-job` SA with `jobs get`
 * and `jobs patch` only — the runner writes its run result on its own Job
 * (ADR-0007). Namespace-wide because Job names are dynamic, which is exactly
 * why the App validates the annotation's Job name against the object.
 */
export function renderJobRbac(): Record<string, unknown>[] {
  return [
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: JOB_SERVICE_ACCOUNT, namespace: NAMESPACE },
      automountServiceAccountToken: true,
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name: JOB_SERVICE_ACCOUNT, namespace: NAMESPACE },
      rules: [{ apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "patch"] }],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: JOB_SERVICE_ACCOUNT, namespace: NAMESPACE },
      subjects: [{ kind: "ServiceAccount", name: JOB_SERVICE_ACCOUNT, namespace: NAMESPACE }],
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: JOB_SERVICE_ACCOUNT },
    },
  ];
}

/**
 * Guardrail quota (docs/deployment.md §7): object counts only. It deliberately
 * carries no `requests.*` / `limits.*` key — any such key would make k8s demand
 * resource declarations from every Pod in the namespace.
 */
export function renderResourceQuota(): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: { name: "remote-agent-guardrail", namespace: NAMESPACE },
    spec: { hard: { "count/jobs.batch": "10", pods: "20" } },
  };
}

export interface StubServiceInput {
  /** In-cluster hostname the App/Job reach the stub on (e.g. `stub-github`). */
  name: string;
  image: string;
  port: number;
  args: string[];
  /** Extra volumes/mounts for the scenario + git project root. */
  volumes?: Array<Record<string, unknown>>;
  volumeMounts?: Array<Record<string, unknown>>;
  env?: Array<Record<string, unknown>>;
}

/**
 * A stub Deployment + Service in the namespace. The stubs are ordinary cluster
 * workloads: the App and Job reach them through Service DNS, exactly as they
 * would reach GitHub or OmniRoute, because the only difference is the base URL
 * the env carries.
 */
export function renderStubService(input: StubServiceInput): Record<string, unknown>[] {
  const labels = { app: input.name, "app.kubernetes.io/part-of": "remote-agent-e2e" };
  return [
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: input.name, namespace: NAMESPACE, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: input.name } },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: input.name,
                image: input.image,
                args: input.args,
                ports: [{ containerPort: input.port }],
                ...(input.env === undefined ? {} : { env: input.env }),
                ...(input.volumeMounts === undefined ? {} : { volumeMounts: input.volumeMounts }),
                readinessProbe: { tcpSocket: { port: input.port }, initialDelaySeconds: 1, periodSeconds: 1 },
              },
            ],
            ...(input.volumes === undefined ? {} : { volumes: input.volumes }),
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: input.name, namespace: NAMESPACE, labels },
      spec: {
        selector: { app: input.name },
        ports: [{ port: input.port, targetPort: input.port }],
      },
    },
  ];
}

export interface AppDeploymentInput {
  image: string;
  /** `http://stub-github:8080` — GITHUB_API_BASE_URL and GIT_BASE_URL point at the same stub. */
  stubGitHubUrl: string;
  /** `http://stub-model:8080/v1` — OMNIROUTE_BASE_URL. */
  stubModelUrl: string;
  /** `owner/name` the scenario targets. */
  targetRepo: string;
}

/**
 * The App Deployment (docs/deployment.md §1: one replica, no database). Its env
 * is the whole test-vs-production difference: `GITHUB_API_BASE_URL`,
 * `GIT_BASE_URL` and `OMNIROUTE_BASE_URL` point at the stubs, and nothing else
 * about the process changes. `NAMESPACE` is where its RBAC applies.
 *
 * The two credentials are `secretKeyRef`s, not literals: production reads them
 * from `remote-agent-secret` (docs/deployment.md §3), and the e2e must exercise
 * that same wiring — a literal here would hide a missing Secret key.
 *
 * The resync interval is short so the harness's polling does not have to wait
 * five minutes for a tick; that is an env override the docs already allow
 * (ADR-0014), not a test branch.
 */
export function renderAppDeployment(input: AppDeploymentInput): Record<string, unknown> {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "remote-agent", namespace: NAMESPACE, labels: { app: "remote-agent" } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: "remote-agent" } },
      template: {
        metadata: { labels: { app: "remote-agent" } },
        spec: {
          serviceAccountName: APP_SERVICE_ACCOUNT,
          containers: [
            {
              name: "app",
              image: input.image,
              ports: [{ containerPort: 8080 }],
              env: [
                { name: "NAMESPACE", value: NAMESPACE },
                { name: "GITHUB_API_BASE_URL", value: input.stubGitHubUrl },
                { name: "GIT_BASE_URL", value: input.stubGitHubUrl },
                { name: "OMNIROUTE_BASE_URL", value: input.stubModelUrl },
                { name: "GITHUB_APP_ID", value: "5390512" },
                { name: "GITHUB_APP_CLIENT_ID", value: "Iv1.stub" },
                { name: "GITHUB_WEBHOOK_SECRET", valueFrom: { secretKeyRef: { name: APP_SECRET, key: "GITHUB_WEBHOOK_SECRET" } } },
                { name: "GITHUB_APP_PRIVATE_KEY", valueFrom: { secretKeyRef: { name: APP_SECRET, key: "GITHUB_APP_PRIVATE_KEY" } } },
                { name: "RESYNC_INTERVAL_SECONDS", value: "5" },
                { name: "MAX_JOBS_GLOBAL", value: "3" },
                { name: "MAX_JOBS_PER_REPO", value: "2" },
              ],
              // TCP, not HTTP: the App's only HTTP surface is `POST /webhook`
              // (ADR-0002), so an HTTP probe on that path would 404 forever.
              readinessProbe: { tcpSocket: { port: 8080 }, initialDelaySeconds: 1, periodSeconds: 1 },
            },
          ],
        },
      },
    },
  };
}

/**
 * `remote-agent-secret` (docs/deployment.md §3): the three keys, exactly. The
 * App reads the private key and the webhook secret; every Job reads only
 * `OMNIROUTE_API_KEY`, by `secretKeyRef` (never `envFrom`).
 *
 * The values are e2e-only — a throwaway signing key, a random webhook secret
 * and a fake gateway key — but the *shape* is production's, so a missing key
 * fails here the way it would there.
 */
export function renderAppSecret(input: {
  privateKey: string;
  webhookSecret: string;
  omniRouteApiKey: string;
}): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: APP_SECRET, namespace: NAMESPACE },
    type: "Opaque",
    stringData: {
      GITHUB_APP_PRIVATE_KEY: input.privateKey,
      GITHUB_WEBHOOK_SECRET: input.webhookSecret,
      OMNIROUTE_API_KEY: input.omniRouteApiKey,
    },
  };
}
