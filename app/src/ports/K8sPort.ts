/**
 * K8sPort — the only kubernetes seam (spec #33 §1). Production implementation
 * is `@kubernetes/client-node` (behind app/src/adapters); tests use the
 * in-memory fake holding full world state.
 *
 * Read shapes (`K8sJob`, `K8sPod`, `K8sSecret`, `K8sPvc`) are what the decision
 * layer needs from the world; create payloads (`K8sJobManifest`,
 * `K8sPvcManifest`) are the objects the App builds. Keeping them apart means a
 * read never has to carry a pod template and a template never pretends to be a
 * live object.
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
  /**
   * Container statuses as the kubelet reported them. Pod state is **not** an
   * outcome signal (docs/architecture.md §4.4) — it is evidence, quoted into the
   * error comment when no run result exists.
   */
  containerStatuses?: K8sContainerStatus[];
}

/** One container's terminal state: `OOMKilled`, `Error`, `Completed`, and its exit code. */
export interface K8sContainerStatus {
  name: string;
  reason?: string;
  exitCode?: number;
}

export interface K8sSecret {
  name: string;
  namespace: string;
  annotations: Record<string, string>;
  /** Provenance labels, same surface as Jobs / Ticket PVCs. */
  labels: Record<string, string>;
  data: Record<string, string>;
  /**
   * Server-assigned RFC3339. Carried because the API returns it, but renewal
   * never reads it: a patch does not move it, so judging token life from it
   * would degrade into re-minting every pass (ADR-0014).
   */
  creationTimestamp?: string;
}

/** In-place Secret patch: renewal swaps the token and its expiry together (ADR-0014). */
export interface K8sSecretPatch {
  data?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface K8sPvc {
  name: string;
  namespace: string;
  annotations: Record<string, string>;
  labels: Record<string, string>;
  /**
   * Server-assigned RFC3339. Only the orphan fallback reads it (ADR-0011): age
   * is the safety pad for the window between Claim and Job creation.
   */
  creationTimestamp?: string;
}

export interface K8sPvcSpec {
  accessModes: string[];
  storageClassName: string;
  resources: { requests: { storage: string } };
}

/** Ticket PVC create payload (ADR-0010 / ADR-0011). */
export interface K8sPvcManifest extends K8sPvc {
  spec: K8sPvcSpec;
}

// --- Job manifest (pod template is built by App code, docs/deployment.md §6) ---

export interface K8sEnvVar {
  name: string;
  value?: string;
  /** Exact single-key reference — never `envFrom` (user story 57). */
  secretKeyRef?: { name: string; key: string };
}

export interface K8sResourceRequirements {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}

export interface K8sVolumeMount {
  name: string;
  mountPath: string;
  /** Mount a single key of a Secret/ConfigMap as one file (used for the token, ADR-0009). */
  subPath?: string;
  readOnly?: boolean;
}

export interface K8sVolume {
  name: string;
  persistentVolumeClaim?: { claimName: string };
  secret?: { secretName: string };
}

export interface K8sContainer {
  name: string;
  image: string;
  env?: K8sEnvVar[];
  volumeMounts?: K8sVolumeMount[];
  resources?: K8sResourceRequirements;
}

export interface K8sPodTemplate {
  serviceAccountName: string;
  /** Forced by `podFailurePolicy` (ADR-0009): a crash is a new pod, never an in-place restart. */
  restartPolicy: "Never";
  terminationGracePeriodSeconds: number;
  securityContext: { fsGroup: number };
  initContainers: K8sContainer[];
  containers: K8sContainer[];
  volumes: K8sVolume[];
}

export interface K8sPodFailurePolicyRule {
  action: "FailJob";
  onExitCodes: { containerName: string; operator: "In"; values: number[] };
}

export interface K8sJobManifest {
  name: string;
  namespace: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  parallelism: number;
  backoffLimit: number;
  activeDeadlineSeconds: number;
  ttlSecondsAfterFinished: number;
  podFailurePolicy: { rules: K8sPodFailurePolicyRule[] };
  podTemplate: K8sPodTemplate;
}

export type K8sEvent =
  | { type: "DELETED"; object: K8sJob }
  | { type: "ADDED"; object: K8sJob };

export interface K8sPort {
  // --- Jobs ---
  getJob(name: string): Promise<K8sJob | null>;
  listJobs(): Promise<K8sJob[]>;
  /** create-if-absent: an existing object is success, not an error (409 = success). */
  createJob(job: K8sJobManifest): Promise<K8sJob>;
  watchJobs(onEvent: (event: K8sEvent) => void): Promise<void>;

  // --- Pods ---
  listPods(): Promise<K8sPod[]>;
  getPod(name: string): Promise<K8sPod | null>;

  // --- Container logs (evidence for error comments) ---
  getPodLog(podName: string): Promise<string>;

  // --- Secrets ---
  createSecret(secret: K8sSecret): Promise<K8sSecret>;
  getSecret(name: string): Promise<K8sSecret | null>;
  patchSecret(name: string, patch: K8sSecretPatch): Promise<K8sSecret>;
  deleteSecret(name: string): Promise<void>;

  // --- Ticket PVCs ---
  createPvc(pvc: K8sPvcManifest): Promise<K8sPvc>;
  getPvc(name: string): Promise<K8sPvc | null>;
  listPvcs(): Promise<K8sPvc[]>;
  patchPvcAnnotations(name: string, annotations: Record<string, string>): Promise<K8sPvc>;
  /**
   * Remove one annotation key (Claim clears `remote-agent/expires-at`). Absent
   * key = no write, so a replayed Claim issues nothing.
   */
  clearPvcAnnotation(name: string, key: string): Promise<K8sPvc>;
  deletePvc(name: string): Promise<void>;
}
