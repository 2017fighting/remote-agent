import type {
  K8sEvent,
  K8sJob,
  K8sPod,
  K8sPort,
  K8sPvc,
  K8sSecret,
} from "../ports/K8sPort.js";

/**
 * In-memory K8sPort fake (App seam, spec #33 Testing Decisions 1).
 * Holds full world state and records every write call; `create*` is
 * create-if-absent (409 semantics = success).
 */
export class FakeK8s implements K8sPort {
  jobs: K8sJob[] = [];
  pods: K8sPod[] = [];
  secrets: K8sSecret[] = [];
  pvcs: K8sPvc[] = [];
  writeLog: string[] = [];
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

  async getJob(name: string): Promise<K8sJob | null> {
    return this.jobs.find((j) => j.name === name) ?? null;
  }

  async listJobs(): Promise<K8sJob[]> {
    return [...this.jobs];
  }

  async createJob(job: K8sJob): Promise<K8sJob> {
    const existing = this.jobs.find((j) => j.name === job.name);
    if (existing) return existing;
    this.jobs.push(job);
    this.record(`createJob ${job.name}`);
    this.emit({ type: "ADDED", object: job });
    return job;
  }

  async watchJobs(onEvent: (event: K8sEvent) => void): Promise<void> {
    this.watchers.push(onEvent);
  }

  async listPods(): Promise<K8sPod[]> {
    return [...this.pods];
  }

  async getPod(name: string): Promise<K8sPod | null> {
    return this.pods.find((p) => p.name === name) ?? null;
  }

  async getPodLog(podName: string): Promise<string> {
    return `fake log tail for ${podName}\n`;
  }

  async createSecret(secret: K8sSecret): Promise<K8sSecret> {
    const existing = this.secrets.find((s) => s.name === secret.name);
    if (existing) return existing;
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

  async createPvc(pvc: K8sPvc): Promise<K8sPvc> {
    const existing = this.pvcs.find((p) => p.name === pvc.name);
    if (existing) return existing;
    this.pvcs.push(pvc);
    this.record(`createPvc ${pvc.name}`);
    return pvc;
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

  async deletePvc(name: string): Promise<void> {
    const idx = this.pvcs.findIndex((p) => p.name === name);
    if (idx >= 0) {
      this.pvcs.splice(idx, 1);
      this.record(`deletePvc ${name}`);
    }
  }
}
