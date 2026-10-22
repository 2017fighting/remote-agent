import {
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  PatchStrategy,
  KubernetesObjectApi,
  Watch,
  type V1ContainerStatus,
  type V1Job,
  type V1ObjectMeta,
  type V1PersistentVolumeClaim,
  type V1Pod,
  type V1Secret,
} from "@kubernetes/client-node";
import { AGENT_CONTAINER_NAME, SEED_CONTAINER_NAME } from "../renders/job-template.js";
import { K8sApiError } from "../ports/errors.js";
import type {
  K8sEvent,
  K8sJob,
  K8sJobManifest,
  K8sPod,
  K8sPort,
  K8sPvc,
  K8sPvcManifest,
  K8sSecret,
  K8sSecretPatch,
} from "../ports/K8sPort.js";

/**
 * Production K8sPort implementation (spec #33 §1: "生产实现是
 * `@kubernetes/client-node`").
 *
 * The load-bearing part is error translation. The decision layer branches on
 * exactly three HTTP classes (`app/src/ports/errors.ts`):
 *
 * - `409 AlreadyExists` — every create is create-if-absent, so Claim treats it
 *   as success;
 * - `403` + a quota message — the Guardrail ResourceQuota said no, which is a
 *   normal branch (no Job, no label, no `agent:error`);
 * - `404` — the object is gone, which is the intent of a reclamation delete.
 *
 * Everything else must fail loudly: a plain `403` is a missing RBAC verb, and
 * swallowing it would look like "quota" and silently stop every Claim. So the
 * translation is deliberately narrow: status → `K8sApiError(status, message)`
 * and nothing else; the classification lives in the port's predicates.
 *
 * Config is in-cluster with a kubeconfig fallback (local runs), and the
 * namespace is the one App config resolved.
 */

/** Log tail budget for the evidence comment (`renders/comments.ts` keeps 40 lines). */
const LOG_TAIL_LINES = 200;

export interface KubeClientK8sConfig {
  namespace: string;
  /** Optional kubeconfig path for local runs; in-cluster config wins when present. */
  kubeconfigPath?: string;
}

export class KubeClientK8s implements K8sPort {
  private readonly namespace: string;
  private readonly batch: BatchV1Api;
  private readonly core: CoreV1Api;
  private readonly objects: KubernetesObjectApi;
  private readonly watch: Watch;

  constructor(config: KubeClientK8sConfig) {
    this.namespace = config.namespace;
    const kubeConfig = loadKubeConfig(config.kubeconfigPath);
    this.batch = kubeConfig.makeApiClient(BatchV1Api);
    this.core = kubeConfig.makeApiClient(CoreV1Api);
    this.objects = kubeConfig.makeApiClient(KubernetesObjectApi);
    this.watch = new Watch(kubeConfig);
  }

  // --- Jobs ---

  async getJob(name: string): Promise<K8sJob | null> {
    try {
      const job = await this.batch.readNamespacedJob({ name, namespace: this.namespace });
      return toJob(job);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw toK8sApiError(error);
    }
  }

  async listJobs(): Promise<K8sJob[]> {
    try {
      const list = await this.batch.listNamespacedJob({ namespace: this.namespace });
      return (list.items ?? []).map(toJob);
    } catch (error) {
      throw toK8sApiError(error);
    }
  }

  /** create-if-absent: a 409 comes back as `K8sApiError(409)` for the port's predicate. */
  async createJob(job: K8sJobManifest): Promise<K8sJob> {
    try {
      const created = await this.batch.createNamespacedJob({
        namespace: job.namespace,
        body: toJobBody(job),
      });
      return toJob(created);
    } catch (error) {
      throw toK8sApiError(error);
    }
  }

  /**
   * Job watch — the wake source for "a run reached a terminal state" and for
   * `DELETED` (ADR-0013: a Job's removal is what re-opens the Claim-gate).
   * Only `ADDED` / `DELETED` carry product meaning here, so the rest is
   * dropped. The stream ends when the connection closes; the resync tick is
   * the backstop that makes that lossless (ADR-0014), which is why a closed
   * watch is not surfaced as a pass failure.
   */
  async watchJobs(onEvent: (event: K8sEvent) => void): Promise<void> {
    await this.watch.watch(
      `/apis/batch/v1/namespaces/${this.namespace}/jobs`,
      {},
      (phase, object) => {
        if (phase !== "ADDED" && phase !== "DELETED") return;
        onEvent({ type: phase, object: toJob(object as V1Job) });
      },
      () => {
        // A closed watch is not a pass failure: the resync tick is the backstop
        // (ADR-0014). Re-arming the watch belongs to whoever owns the wake
        // surface, not to this per-call method.
      },
    );
  }

  // --- Pods ---

  async listPods(): Promise<K8sPod[]> {
    try {
      const list = await this.core.listNamespacedPod({ namespace: this.namespace });
      return (list.items ?? []).map(toPod);
    } catch (error) {
      throw toK8sApiError(error);
    }
  }

  async getPod(name: string): Promise<K8sPod | null> {
    try {
      const pod = await this.core.readNamespacedPod({ name, namespace: this.namespace });
      return toPod(pod);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw toK8sApiError(error);
    }
  }

  /**
   * Container log tail; the caller truncates to the comment's budget.
   *
   * The agent container is the interesting one, but the most common `error`
   * path is a seed failure — and then the agent container never started, so its
   * log does not exist. Falling back to the init container is what keeps the
   * evidence comment from saying "no logs available" exactly when the seed is
   * the thing that broke (ADR-0009).
   */
  async getPodLog(podName: string): Promise<string> {
    try {
      return await this.podLog(podName, AGENT_CONTAINER_NAME);
    } catch (error) {
      try {
        return await this.podLog(podName, SEED_CONTAINER_NAME);
      } catch {
        throw toK8sApiError(error);
      }
    }
  }

  private async podLog(podName: string, container: string): Promise<string> {
    try {
      return await this.core.readNamespacedPodLog({
        name: podName,
        namespace: this.namespace,
        container,
        tailLines: LOG_TAIL_LINES,
      });
    } catch (error) {
      throw toK8sApiError(error);
    }
  }

  // --- Secrets ---

  async createSecret(secret: K8sSecret): Promise<K8sSecret> {
    try {
      const created = await this.core.createNamespacedSecret({
        namespace: secret.namespace,
        body: {
          metadata: { name: secret.name, annotations: secret.annotations, labels: secret.labels },
          data: secret.data,
          type: "Opaque",
        },
      });
      return toSecret(created);
    } catch (error) {
      throw toK8sApiError(error);
    }
  }

  async getSecret(name: string): Promise<K8sSecret | null> {
    try {
      const secret = await this.core.readNamespacedSecret({ name, namespace: this.namespace });
      return toSecret(secret);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw toK8sApiError(error);
    }
  }

  /**
   * In-place renewal (ADR-0014): a merge patch moves `data` and `annotations`
   * together. Nothing changed = no write, so a replayed pass issues nothing.
   */
  async patchSecret(name: string, patch: K8sSecretPatch): Promise<K8sSecret> {
    const current = await this.getSecret(name);
    if (current === null) {
      throw new K8sApiError(404, `secrets "${name}" not found`);
    }
    const unchanged =
      Object.entries(patch.data ?? {}).every(([key, value]) => current.data[key] === value) &&
      Object.entries(patch.annotations ?? {}).every(([key, value]) => current.annotations[key] === value);
    if (unchanged) return current;
    try {
      const patched = await this.objects.patch(
        {
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name, namespace: this.namespace, ...(patch.annotations ? { annotations: patch.annotations } : {}) },
          ...(patch.data ? { data: patch.data } : {}),
        },
        undefined,
        undefined,
        undefined,
        undefined,
        PatchStrategy.MergePatch,
      );
      return toSecret(patched as V1Secret);
    } catch (error) {
      throw toK8sApiError(error);
    }
  }

  async deleteSecret(name: string): Promise<void> {
    try {
      await this.core.deleteNamespacedSecret({ name, namespace: this.namespace });
    } catch (error) {
      throw toK8sApiError(error);
    }
  }

  // --- Ticket PVCs ---

  async createPvc(pvc: K8sPvcManifest): Promise<K8sPvc> {
    try {
      const created = await this.core.createNamespacedPersistentVolumeClaim({
        namespace: pvc.namespace,
        body: {
          metadata: { name: pvc.name, annotations: pvc.annotations, labels: pvc.labels },
          spec: {
            accessModes: pvc.spec.accessModes,
            storageClassName: pvc.spec.storageClassName,
            resources: { requests: { storage: pvc.spec.resources.requests.storage } },
          },
        },
      });
      return toPvc(created);
    } catch (error) {
      throw toK8sApiError(error);
    }
  }

  async getPvc(name: string): Promise<K8sPvc | null> {
    try {
      const pvc = await this.core.readNamespacedPersistentVolumeClaim({
        name,
        namespace: this.namespace,
      });
      return toPvc(pvc);
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw toK8sApiError(error);
    }
  }

  async listPvcs(): Promise<K8sPvc[]> {
    try {
      const list = await this.core.listNamespacedPersistentVolumeClaim({ namespace: this.namespace });
      return (list.items ?? []).map(toPvc);
    } catch (error) {
      throw toK8sApiError(error);
    }
  }

  /** Set-if-changed: an identical annotation set is not a write (replayability). */
  async patchPvcAnnotations(name: string, annotations: Record<string, string>): Promise<K8sPvc> {
    const current = await this.getPvc(name);
    if (current === null) {
      throw new K8sApiError(404, `persistentvolumeclaims "${name}" not found`);
    }
    if (Object.entries(annotations).every(([key, value]) => current.annotations[key] === value)) return current;
    try {
      const patched = await this.objects.patch(
        {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: { name, namespace: this.namespace, annotations },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        PatchStrategy.MergePatch,
      );
      return toPvc(patched as V1PersistentVolumeClaim);
    } catch (error) {
      throw toK8sApiError(error);
    }
  }

  /**
   * Remove one annotation key. A merge patch with a `null` value deletes the
   * key; the read is not skipped because the port's contract is "absent key =
   * no write", which only the caller's world state can decide.
   */
  async clearPvcAnnotation(name: string, key: string): Promise<K8sPvc> {
    const current = await this.getPvc(name);
    if (current === null) {
      throw new K8sApiError(404, `persistentvolumeclaims "${name}" not found`);
    }
    // Absent key = no write (the port's contract), which is what makes a
    // replayed Claim issue nothing.
    if (current.annotations[key] === undefined) return current;
    try {
      // `null` is the JSON-merge-patch delete marker, which the generated
      // `V1ObjectMeta` type does not model (it types annotation values as
      // `string`), hence the one cast in this file.
      const annotations = { [key]: null } as unknown as Record<string, string>;
      const patched = await this.objects.patch(
        {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: { name, namespace: this.namespace, annotations },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        PatchStrategy.MergePatch,
      );
      return toPvc(patched as V1PersistentVolumeClaim);
    } catch (error) {
      throw toK8sApiError(error);
    }
  }

  async deletePvc(name: string): Promise<void> {
    try {
      await this.core.deleteNamespacedPersistentVolumeClaim({ name, namespace: this.namespace });
    } catch (error) {
      throw toK8sApiError(error);
    }
  }
}

/**
 * In-cluster first, kubeconfig second (spec #43: "In-cluster config with
 * kubeconfig fallback"). `loadFromDefault` already prefers a kubeconfig; the
 * service-account token is the production truth, so it is probed explicitly.
 */
function loadKubeConfig(kubeconfigPath?: string): KubeConfig {
  const kubeConfig = new KubeConfig();
  if (kubeconfigPath !== undefined) {
    kubeConfig.loadFromFile(kubeconfigPath);
    return kubeConfig;
  }
  if (process.env["KUBERNETES_SERVICE_HOST"] !== undefined) {
    kubeConfig.loadFromCluster();
    return kubeConfig;
  }
  kubeConfig.loadFromDefault();
  return kubeConfig;
}

/** A 404 from any of the generated clients means "gone", never "fail the pass". */
function isNotFoundError(error: unknown): boolean {
  return statusOf(error) === 404;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number") return code;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

/**
 * The whole point of this file: one status → one `K8sApiError`. The message is
 * the server's own `Status.message`, which is where the quota text
 * ("exceeded quota: ...") lives for `isQuotaExceeded` to match.
 */
function toK8sApiError(error: unknown): unknown {
  if (error instanceof K8sApiError) return error;
  const status = statusOf(error);
  if (status === undefined) return error;
  return new K8sApiError(status, messageOf(error));
}

function messageOf(error: unknown): string {
  const body = (error as { body?: unknown }).body;
  if (typeof body === "object" && body !== null) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
  }
  return error instanceof Error ? error.message : String(error);
}

function metadataOf(meta: V1ObjectMeta | undefined): {
  name: string;
  namespace: string;
  annotations: Record<string, string>;
  labels: Record<string, string>;
  creationTimestamp?: string;
} {
  return {
    name: meta?.name ?? "",
    namespace: meta?.namespace ?? "",
    annotations: meta?.annotations ?? {},
    labels: meta?.labels ?? {},
    ...(meta?.creationTimestamp === undefined
      ? {}
      : { creationTimestamp: toIsoString(meta.creationTimestamp) }),
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** A Job is finished once `Complete` or `Failed` is True — the only terminal signal App reads (ADR-0008). */
function toJob(job: V1Job): K8sJob {
  const meta = metadataOf(job.metadata);
  const conditions = (job.status?.conditions ?? []).map((condition) => ({
    type: condition.type,
    status: condition.status,
    ...(condition.reason === undefined ? {} : { reason: condition.reason }),
  }));
  const finished = conditions.some(
    (condition) => condition.status === "True" && (condition.type === "Complete" || condition.type === "Failed"),
  );
  return {
    name: meta.name,
    namespace: meta.namespace,
    labels: meta.labels,
    annotations: meta.annotations,
    conditions,
    finished,
  };
}

function toPod(pod: V1Pod): K8sPod {
  const meta = metadataOf(pod.metadata);
  const owner = (pod.metadata?.ownerReferences ?? []).find((ref) => ref.kind === "Job");
  return {
    name: meta.name,
    namespace: meta.namespace,
    ...(owner?.name === undefined ? {} : { ownerJobName: owner.name }),
    phase: pod.status?.phase ?? "Unknown",
    // Terminating still holds its Slot (docs/architecture.md §5).
    deleting: pod.metadata?.deletionTimestamp !== undefined,
    containerStatuses: containerStatuses(pod),
  };
}

/** Both lists matter: a seed failure is in `initContainerStatuses` (ADR-0009). */
function containerStatuses(pod: V1Pod): K8sPod["containerStatuses"] {
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  if (statuses.length === 0) return undefined;
  return statuses.map((status: V1ContainerStatus) => {
    const terminated = status.state?.terminated;
    return {
      name: status.name,
      ...(terminated?.reason === undefined ? {} : { reason: terminated.reason }),
      ...(terminated?.exitCode === undefined ? {} : { exitCode: terminated.exitCode }),
    };
  });
}

function toSecret(secret: V1Secret): K8sSecret {
  const meta = metadataOf(secret.metadata);
  return {
    name: meta.name,
    namespace: meta.namespace,
    annotations: meta.annotations,
    labels: meta.labels,
    data: secret.data ?? {},
    ...(meta.creationTimestamp === undefined ? {} : { creationTimestamp: meta.creationTimestamp }),
  };
}

function toPvc(pvc: V1PersistentVolumeClaim): K8sPvc {
  const meta = metadataOf(pvc.metadata);
  return {
    name: meta.name,
    namespace: meta.namespace,
    annotations: meta.annotations,
    labels: meta.labels,
    ...(meta.creationTimestamp === undefined ? {} : { creationTimestamp: meta.creationTimestamp }),
  };
}

/**
 * The App-built manifest is the single source of the pod template
 * (docs/deployment.md §6), so this is a field-for-field copy — no defaults
 * invented here, or a code constant and the created object could disagree.
 */
function toJobBody(job: K8sJobManifest): V1Job {
  const { podTemplate } = job;
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: job.name, namespace: job.namespace, labels: job.labels, annotations: job.annotations },
    spec: {
      parallelism: job.parallelism,
      backoffLimit: job.backoffLimit,
      activeDeadlineSeconds: job.activeDeadlineSeconds,
      ttlSecondsAfterFinished: job.ttlSecondsAfterFinished,
      podFailurePolicy: { rules: job.podFailurePolicy.rules },
      template: {
        metadata: { labels: job.labels },
        spec: {
          serviceAccountName: podTemplate.serviceAccountName,
          restartPolicy: podTemplate.restartPolicy,
          terminationGracePeriodSeconds: podTemplate.terminationGracePeriodSeconds,
          securityContext: { fsGroup: podTemplate.securityContext.fsGroup },
          initContainers: podTemplate.initContainers,
          containers: podTemplate.containers,
          volumes: podTemplate.volumes,
        },
      },
    },
  };
}
