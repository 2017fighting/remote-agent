import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobAnnotationWriter, inClusterAnnotationWriter } from "../src/internal/annotation.js";

/**
 * The annotation is the run's only k8s write and the App's only result source, so
 * these tests pin the two ways it silently disappears: a wrong URL/name (404) and
 * an untrusted CA (`fetch failed`, which the runner can only report as
 * `run-failed detail=fetch failed` after a successful push).
 */
async function tokenFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ra-annotation-"));
  const path = join(dir, "token");
  await writeFile(path, "sa-token\n");
  return path;
}

describe("JobAnnotationWriter", () => {
  it("PATCHes the Job's own annotation with the run result", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const writer = new JobAnnotationWriter({
      jobName: "agent-o-r-34",
      jobNamespace: "remote-agent",
      apiBaseUrl: "https://10.0.0.1:443/",
      tokenPath: await tokenFile(),
      caPath: "/nonexistent",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("{}", { status: 200 });
      },
    });

    await writer.write({ v: 1, outcome: "done", summary: "shipped" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://10.0.0.1:443/apis/batch/v1/namespaces/remote-agent/jobs/agent-o-r-34");
    expect(calls[0]!.init.method).toBe("PATCH");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer sa-token");
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, any>;
    expect(JSON.parse(body["metadata"]["annotations"]["remote-agent/run-result"])).toMatchObject({
      outcome: "done",
      summary: "shipped",
    });
  });

  it("fails loudly when the patch does not land, so the pod retries instead of losing the result", async () => {
    const writer = new JobAnnotationWriter({
      jobName: "agent-o-r-34",
      jobNamespace: "remote-agent",
      apiBaseUrl: "https://10.0.0.1:443",
      tokenPath: await tokenFile(),
      caPath: "/nonexistent",
      fetch: async () => new Response("nope", { status: 404 }),
    });

    await expect(writer.write({ v: 1, outcome: "done", summary: "x" })).rejects.toThrow(/404/);
  });

  it("builds the in-cluster API URL from the downward-API host/port pair", () => {
    const writer = inClusterAnnotationWriter(
      { KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "443" },
      { jobName: "agent-o-r-34", jobNamespace: "remote-agent" },
    );
    expect(writer).toBeInstanceOf(JobAnnotationWriter);
  });

  it("refuses to start without the downward-API host/port, rather than guessing an endpoint", () => {
    expect(() =>
      inClusterAnnotationWriter({}, { jobName: "agent-o-r-34", jobNamespace: "remote-agent" }),
    ).toThrow(/KUBERNETES_SERVICE_HOST/);
  });
});
