/**
 * K8sPort — the only kubernetes seam (spec #33 §1). Production implementation
 * is `@kubernetes/client-node` (behind app/src/adapters); tests use the
 * in-memory fake holding full world state.
 */

export interface JobCondition {
  type: string;
  status: string;
  reason?: string;
}

export interface K8sJob {
  name: string;
  namespace: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  conditions: JobCondition[];
  /** True once the Job reached Complete or Failed — the only terminal signal App reads. */
  finished: boolean;
}

export interface K8sPod {
  name: string;
  namespace: string;
  /** ownerReferences → the Job whose Slot this pod holds. */
  ownerJobName?: string;
  phase: string;
  /** True while the pod is terminating; Terminating still holds its Slot. */
  deleting: boolean;
}

export interface K8sSecret {
  name: string;
  namespace: string;
  annotations: Record<string, string>;
  data: Record<string, string>;
}

export interface K8sPvc {
  name: string;
  namespace: string;
  annotations: Record<string, string>;
  labels: Record<string, string>;
}

export type K8sEvent =
  | { type: "DELETED"; object: K8sJob }
  | { type: "ADDED"; object: K8sJob };

export interface K8sPort {
  // --- Jobs ---
  getJob(name: string): Promise<K8sJob | null>;
  listJobs(): Promise<K8sJob[]>;
  /** create-if-absent: an existing object is success, not an error (409 = success). */
  createJob(job: K8sJob): Promise<K8sJob>;
  watchJobs(onEvent: (event: K8sEvent) => void): Promise<void>;

  // --- Pods ---
  listPods(): Promise<K8sPod[]>;
  getPod(name: string): Promise<K8sPod | null>;

  // --- Container logs (evidence for error comments) ---
  getPodLog(podName: string): Promise<string>;

  // --- Secrets ---
  createSecret(secret: K8sSecret): Promise<K8sSecret>;
  getSecret(name: string): Promise<K8sSecret | null>;
  patchSecretAnnotations(name: string, annotations: Record<string, string>): Promise<K8sSecret>;
  deleteSecret(name: string): Promise<void>;

  // --- Ticket PVCs ---
  createPvc(pvc: K8sPvc): Promise<K8sPvc>;
  getPvc(name: string): Promise<K8sPvc | null>;
  listPvcs(): Promise<K8sPvc[]>;
  patchPvcAnnotations(name: string, annotations: Record<string, string>): Promise<K8sPvc>;
  deletePvc(name: string): Promise<void>;
}
