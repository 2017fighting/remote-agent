import { readFile } from "node:fs/promises";
import { ANNOTATIONS, type RunResultV1 } from "@remote-agent/shared";

/** Where the pod's own ServiceAccount credentials live inside the container. */
const SERVICE_ACCOUNT = {
  token: "/var/run/secrets/kubernetes.io/serviceaccount/token",
  ca: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
  host: "KUBERNETES_SERVICE_HOST",
  port: "KUBERNETES_SERVICE_PORT",
} as const;

export interface AnnotationWriterOptions {
  jobName: string;
  jobNamespace: string;
  /** In-cluster API base URL; the env vars are the standard downward-API pair. */
  apiBaseUrl: string;
  tokenPath: string;
  caPath: string;
  /** Injected in tests; production leaves it undefined so `fetch` uses the pod CA. */
  fetch?: typeof fetch;
  log?(line: string): void;
}

/**
 * The runner's only kubernetes write: a JSON merge patch of its own Job's
 * `remote-agent/run-result` annotation (ADR-0007). The Job's SA has
 * `jobs get,patch` and nothing else.
 */
export class JobAnnotationWriter {
  constructor(private readonly options: AnnotationWriterOptions) {}

  /** Write the run result exactly once. Throws when the patch does not land. */
  async write(result: RunResultV1): Promise<void> {
    const token = (await readFile(this.options.tokenPath, "utf8")).trim();
    const url = `${this.options.apiBaseUrl.replace(/\/+$/, "")}/apis/batch/v1/namespaces/${encodeURIComponent(
      this.options.jobNamespace,
    )}/jobs/${encodeURIComponent(this.options.jobName)}`;
    const body = JSON.stringify({ metadata: { annotations: { [ANNOTATIONS.runResult]: JSON.stringify(result) } } });
    const response = await (this.options.fetch ?? fetch)(url, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/merge-patch+json",
        accept: "application/json",
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`job annotation patch failed: ${response.status} ${await response.text()}`);
    }
    this.options.log?.(`annotation-written job=${this.options.jobName} outcome=${result.outcome}`);
  }
}

export function inClusterAnnotationWriter(
  env: Record<string, string | undefined>,
  job: { jobName: string; jobNamespace: string },
  log?: (line: string) => void,
): JobAnnotationWriter {
  const host = env[SERVICE_ACCOUNT.host];
  const port = env[SERVICE_ACCOUNT.port];
  if (!host || !port) throw new Error("KUBERNETES_SERVICE_HOST/PORT are not set: cannot write the run result");
  return new JobAnnotationWriter({
    jobName: job.jobName,
    jobNamespace: job.jobNamespace,
    apiBaseUrl: `https://${host}:${port}`,
    tokenPath: SERVICE_ACCOUNT.token,
    caPath: SERVICE_ACCOUNT.ca,
    ...(log === undefined ? {} : { log }),
  });
}
