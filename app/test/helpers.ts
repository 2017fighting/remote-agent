import { readAppConfig, type AppConfig, type EnvSource } from "../src/config.js";
import type { K8sJob, K8sJobManifest, K8sPvc, K8sPvcManifest } from "../src/ports/K8sPort.js";

/** App config with code defaults, optionally overridden by env (tests read config the same way production does). */
export function testConfig(env: EnvSource = {}): AppConfig {
  return readAppConfig(env);
}

export const NAMESPACE = "remote-agent";

/** A live Job object in the fake world (read shape). */
export function existingJob(input: {
  name: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  finished?: boolean;
}): K8sJob {
  return {
    name: input.name,
    namespace: NAMESPACE,
    labels: input.labels ?? {},
    annotations: input.annotations ?? {},
    conditions: [],
    finished: input.finished ?? false,
  };
}

/** A minimal Job manifest, for fakes tests that only care about create-if-absent. */
export function jobManifest(name: string): K8sJobManifest {
  return {
    name,
    namespace: NAMESPACE,
    labels: {},
    annotations: {},
    parallelism: 1,
    backoffLimit: 4,
    activeDeadlineSeconds: 10800,
    ttlSecondsAfterFinished: 1800,
    podFailurePolicy: { rules: [] },
    podTemplate: {
      serviceAccountName: "agent-job",
      restartPolicy: "Never",
      terminationGracePeriodSeconds: 120,
      securityContext: { fsGroup: 1000 },
      initContainers: [],
      containers: [],
      volumes: [],
    },
  };
}

export function pvcManifest(name: string): K8sPvcManifest {
  return {
    name,
    namespace: NAMESPACE,
    annotations: {},
    labels: {},
    spec: {
      accessModes: ["ReadWriteOncePod"],
      storageClassName: "truenas-iscsi-delete",
      resources: { requests: { storage: "8Gi" } },
    },
  };
}

export function existingPvc(name: string): K8sPvc {
  return { name, namespace: NAMESPACE, annotations: {}, labels: {} };
}
