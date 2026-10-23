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
  /** Injected in tests. Production builds one bound to the ServiceAccount CA. */
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
    const doFetch = this.options.fetch ?? (await this.podTrustFetch());
    const url = `${this.options.apiBaseUrl.replace(/\/+$/, "")}/apis/batch/v1/namespaces/${encodeURIComponent(
      this.options.jobNamespace,
    )}/jobs/${encodeURIComponent(this.options.jobName)}`;
    const body = JSON.stringify({ metadata: { annotations: { [ANNOTATIONS.runResult]: JSON.stringify(result) } } });
    const response = await doFetch(url, {
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

  /**
   * `fetch` bound to the ServiceAccount CA.
   *
   * Node's global `fetch` trusts its bundled root store only: it does not read
   * the pod's mounted CA, so a call to the in-cluster API server fails with a
   * bare `fetch failed` (a TLS error the runner could only report as
   * `run-failed detail=fetch failed`). The Job's RBAC is right and the push has
   * already succeeded, so losing the annotation here costs the whole run result.
   */
  private async podTrustFetch(): Promise<typeof fetch> {
    const { Agent, setGlobalDispatcher } = await import("undici");
    const ca = await readFile(this.options.caPath, "utf8");
    // The API server's certificate carries the service DNS name, which is what
    // apiBaseUrl already uses; pinning the CA is the only missing piece.
    setGlobalDispatcher(new Agent({ connect: { ca } }));
    return fetch;
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
