import { isAlreadyExists, K8sApiError } from "../ports/errors.js";
import type {
  K8sEvent,
  K8sJob,
  K8sJobManifest,
  K8sPod,
  K8sPort,
  K8sPvc,
  K8sPvcManifest,
  K8sSecret,
} from "../ports/K8sPort.js";

/**
 * In-memory K8sPort fake (App seam, spec #33 Testing Decisions 1).
 * Holds full world state and records every write call; `create*` is
 * create-if-absent (409 semantics = success). Created manifests are kept so
 * tests can assert the Job's decision surface (image, env, volumes, budgets,
 * `podFailurePolicy`, TTL, labels) — read objects carry no pod template.
 */
export class FakeK8s implements K8sPort {
  jobs: K8sJob[] = [];
  pods: K8sPod[] = [];
  secrets: K8sSecret[] = [];
  pvcs: K8sPvc[] = [];
  /** Every create payload, in call order. */
  jobManifests: K8sJobManifest[] = [];
  pvcManifests: K8sPvcManifest[] = [];
  writeLog: string[] = [];
  /** When set, the next matching create throws this error (failure injection). */
  failNextCreate?: { object: "job" | "secret" | "pvc"; error: Error };
  private watchers: Array<(event: K8sEvent) => void> = [];

  constructor(world?: { jobs?: K8sJob[]; pods?: K8sPod[]; secrets?: K8sSecret[]; pvcs?: K8sPvc[] }) {
    if (world?.jobs) this.jobs.push(...world.jobs);
    if (world?.pods) this.pods.push(...world.pods);
    if (world?.secrets) this.secrets.push(...world.secrets);
    if (world?.pvcs) this.pvcs.push(...world.pvcs);
  }

  private record(entry: string): void {
    this.writeLog.push(entry);
  }

  private emit(event: K8sEvent): void {
    for (const w of this.watchers) w(event);
  }

  private takeInjectedFailure(object: "job" | "secret" | "pvc"): void {
    if (this.failNextCreate?.object !== object) return;
    const { error } = this.failNextCreate;
    this.failNextCreate = undefined;
    throw error;
  }

  async getJob(name: string): Promise<K8sJob | null> {
    const job = this.jobs.find((j) => j.name === name);
    return job === undefined ? null : this.withAnnotationReadLog(job);
  }

  async listJobs(): Promise<K8sJob[]> {
    return this.jobs.map((job) => this.withAnnotationReadLog(job));
  }

  /**
   * Counts reads of a Job's annotations, per key, so a test can pin the
   * "annotation is consumed exactly once" discipline (ADR-0007 / ADR-0013)
   * without reaching into the decision code.
   */
  jobAnnotationReads: Array<{ job: string; key: string }> = [];

  private withAnnotationReadLog(job: K8sJob): K8sJob {
    const readLog = this.jobAnnotationReads;
    const annotations = new Proxy(job.annotations, {
      get(target, key, receiver) {
        if (typeof key === "string") readLog.push({ job: job.name, key });
        return Reflect.get(target, key, receiver);
      },
    });
    return new Proxy(job, {
      get(target, key, receiver) {
        if (key === "annotations") return annotations;
        return Reflect.get(target, key, receiver);
      },
    });
  }

  async createJob(job: K8sJobManifest): Promise<K8sJob> {
    const existing = this.jobs.find((j) => j.name === job.name);
    if (existing) throw new K8sApiError(409, `jobs.batch "${job.name}" already exists`);
    this.takeInjectedFailure("job");
    const created: K8sJob = {
      name: job.name,
      namespace: job.namespace,
      labels: { ...job.labels },
      annotations: { ...job.annotations },
      conditions: [],
      finished: false,
    };
    this.jobs.push(created);
    this.jobManifests.push(job);
    this.record(`createJob ${job.name}`);
    this.emit({ type: "ADDED", object: created });
    return created;
  }

  async watchJobs(onEvent: (event: K8sEvent) => void): Promise<void> {
    this.watchers.push(onEvent);
  }

  /** Simulate k8s TTL / manual deletion: removes the Job and emits DELETED. */
  deleteJob(name: string): void {
    const idx = this.jobs.findIndex((j) => j.name === name);
    if (idx < 0) return;
    const [job] = this.jobs.splice(idx, 1);
    this.record(`deleteJob ${name}`);
    if (job) this.emit({ type: "DELETED", object: job });
  }

  async listPods(): Promise<K8sPod[]> {
    return [...this.pods];
  }

  async getPod(name: string): Promise<K8sPod | null> {
    return this.pods.find((p) => p.name === name) ?? null;
  }

  async getPodLog(podName: string): Promise<string> {
    return this.podLogs.get(podName) ?? `fake log tail for ${podName}\n`;
  }

  /** Container log tails by pod name; unset pods return a stub line. */
  podLogs = new Map<string, string>();

  async createSecret(secret: K8sSecret): Promise<K8sSecret> {
    const existing = this.secrets.find((s) => s.name === secret.name);
    if (existing) throw new K8sApiError(409, `secrets "${secret.name}" already exists`);
    this.takeInjectedFailure("secret");
    this.secrets.push(secret);
    this.record(`createSecret ${secret.name}`);
    return secret;
  }

  async getSecret(name: string): Promise<K8sSecret | null> {
    return this.secrets.find((s) => s.name === name) ?? null;
  }

  async patchSecretAnnotations(name: string, annotations: Record<string, string>): Promise<K8sSecret> {
    const secret = this.secrets.find((s) => s.name === name);
    if (!secret) throw new Error(`secret not found: ${name}`);
    const changed = Object.entries(annotations).some(([k, v]) => secret.annotations[k] !== v);
    if (changed) {
      secret.annotations = { ...secret.annotations, ...annotations };
      this.record(`patchSecretAnnotations ${name}`);
    }
    return secret;
  }

  async deleteSecret(name: string): Promise<void> {
    const idx = this.secrets.findIndex((s) => s.name === name);
    if (idx >= 0) {
      this.secrets.splice(idx, 1);
      this.record(`deleteSecret ${name}`);
    }
  }

  async createPvc(pvc: K8sPvcManifest): Promise<K8sPvc> {
    const existing = this.pvcs.find((p) => p.name === pvc.name);
    if (existing) throw new K8sApiError(409, `persistentvolumeclaims "${pvc.name}" already exists`);
    this.takeInjectedFailure("pvc");
    const created: K8sPvc = {
      name: pvc.name,
      namespace: pvc.namespace,
      annotations: { ...pvc.annotations },
      labels: { ...pvc.labels },
    };
    this.pvcs.push(created);
    this.pvcManifests.push(pvc);
    this.record(`createPvc ${pvc.name}`);
    return created;
  }

  async getPvc(name: string): Promise<K8sPvc | null> {
    return this.pvcs.find((p) => p.name === name) ?? null;
  }

  async listPvcs(): Promise<K8sPvc[]> {
    return [...this.pvcs];
  }

  async patchPvcAnnotations(name: string, annotations: Record<string, string>): Promise<K8sPvc> {
    const pvc = this.pvcs.find((p) => p.name === name);
    if (!pvc) throw new Error(`pvc not found: ${name}`);
    const changed = Object.entries(annotations).some(([k, v]) => pvc.annotations[k] !== v);
    if (changed) {
      pvc.annotations = { ...pvc.annotations, ...annotations };
      this.record(`patchPvcAnnotations ${name}`);
    }
    return pvc;
  }

  async clearPvcAnnotation(name: string, key: string): Promise<K8sPvc> {
    const pvc = this.pvcs.find((p) => p.name === name);
    if (!pvc) throw new Error(`pvc not found: ${name}`);
    if (pvc.annotations[key] === undefined) return pvc;
    const { [key]: _removed, ...rest } = pvc.annotations;
    pvc.annotations = rest;
    this.record(`clearPvcAnnotation ${name} ${key}`);
    return pvc;
  }

  async deletePvc(name: string): Promise<void> {
    const idx = this.pvcs.findIndex((p) => p.name === name);
    if (idx >= 0) {
      this.pvcs.splice(idx, 1);
      this.record(`deletePvc ${name}`);
    }
  }
}

export { isAlreadyExists };
