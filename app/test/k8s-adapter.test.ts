import { afterEach, describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KubeClientK8s } from "../src/adapters/k8s.js";
import { isAlreadyExists, isNotFound, isQuotaExceeded, K8sApiError } from "../src/ports/errors.js";
import { jobManifest, pvcManifest } from "./helpers.js";
import { json, startStubServer, type StubRequest, type StubServer } from "./http-stub.js";

/**
 * Production k8s adapter against a fake Kubernetes API (spec #43: "a fake k8s
 * API — no real network, no real cluster"). The fake speaks the REST paths
 * `@kubernetes/client-node` actually calls, so the assertions are about the
 * wire and about the error shapes the decision layer branches on.
 */

const NAMESPACE = "remote-agent";
const JOB_PATH = `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`;
const PODS_PATH = `/api/v1/namespaces/${NAMESPACE}/pods`;
const SECRETS_PATH = `/api/v1/namespaces/${NAMESPACE}/secrets`;
const PVC_PATH = `/api/v1/namespaces/${NAMESPACE}/persistentvolumeclaims`;

let stub: StubServer | undefined;

afterEach(async () => {
  const server = stub;
  stub = undefined;
  await server?.close();
});

/** The `Status` body Kubernetes returns for a non-2xx, which carries the message the App matches on. */
function statusFailure(status: number, message: string, reason: string) {
  return json(status, { kind: "Status", apiVersion: "v1", status: "Failure", message, reason, code: status });
}

/** Server-side defaulting: `metadata.namespace` comes from the request URL, not the body. */
function withNamespace(body: Record<string, unknown>): Record<string, unknown> {
  const metadata = (body["metadata"] ?? {}) as Record<string, unknown>;
  return { ...body, metadata: { ...metadata, namespace: NAMESPACE } };
}

interface FakeWorld {
  jobs: Record<string, unknown>[];
  pods: Record<string, unknown>[];
  secrets: Record<string, unknown>[];
  pvcs: Record<string, unknown>[];
  /** Injected failures, keyed by `METHOD path`, consumed once. */
  failures: Map<string, () => ReturnType<typeof statusFailure>>;
  watchEvents: string[];
  /** Containers whose log endpoint 400s, as Kubernetes does for a container that never started. */
  missingContainers: Set<string>;
}

function fakeApi(world: Partial<FakeWorld> = {}) {
  const state: FakeWorld = {
    jobs: [],
    pods: [],
    secrets: [],
    pvcs: [],
    failures: new Map(),
    watchEvents: [],
    missingContainers: new Set<string>(),
    ...world,
  };

  const handler = (request: StubRequest) => {
    const { method, path } = request;
    const failure = state.failures.get(`${method} ${path}`);
    if (failure !== undefined) {
      state.failures.delete(`${method} ${path}`);
      return failure();
    }

    // Discovery, needed by KubernetesObjectApi to resolve kind → resource.
    if (path === "/api/v1") {
      return json(200, {
        kind: "APIResourceList",
        groupVersion: "v1",
        resources: [
          { name: "secrets", singularName: "", namespaced: true, kind: "Secret", verbs: ["create", "delete", "get", "patch"] },
          {
            name: "persistentvolumeclaims",
            singularName: "",
            namespaced: true,
            kind: "PersistentVolumeClaim",
            verbs: ["create", "delete", "get", "list", "patch"],
          },
        ],
      });
    }

    // --- Jobs ---
    if (path === JOB_PATH && method === "GET" && request.query.get("watch") === "true") {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        write: (res: ServerResponse) => {
          for (const event of state.watchEvents) res.write(`${event}\n`);
          res.end();
        },
      };
    }
    if (path === JOB_PATH && method === "GET") {
      return json(200, { kind: "JobList", items: state.jobs });
    }
    if (path === JOB_PATH && method === "POST") {
      const body = withNamespace(request.json() as Record<string, unknown>);
      state.jobs.push(body);
      return json(201, body);
    }
    if (path.startsWith(`${JOB_PATH}/`) && method === "GET") {
      const name = path.slice(JOB_PATH.length + 1);
      const job = state.jobs.find((item) => (item["metadata"] as { name: string }).name === name);
      return job === undefined ? statusFailure(404, `jobs.batch "${name}" not found`, "NotFound") : json(200, job);
    }

    // --- Pods ---
    if (path === PODS_PATH && method === "GET") {
      return json(200, { kind: "PodList", items: state.pods });
    }
    if (path.startsWith(`${PODS_PATH}/`) && path.endsWith("/log")) {
      // A seed failure has no runner container to read, which is the real 400
      // Kubernetes returns; the fake mirrors it so the fallback is exercised.
      if (state.missingContainers.has(request.query.get("container") ?? "")) {
        return statusFailure(
          400,
          `container ${request.query.get("container")} is not valid for pod`,
          "BadRequest",
        );
      }
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: request.query.get("container") === "seed" ? "seed failed\n" : "seed ok\nrunner: working\n",
      };
    }
    if (path.startsWith(`${PODS_PATH}/`) && method === "GET") {
      const name = path.slice(PODS_PATH.length + 1);
      const pod = state.pods.find((item) => (item["metadata"] as { name: string }).name === name);
      return pod === undefined ? statusFailure(404, `pods "${name}" not found`, "NotFound") : json(200, pod);
    }

    // --- Secrets ---
    if (path === SECRETS_PATH && method === "POST") {
      const body = withNamespace(request.json() as Record<string, unknown>);
      state.secrets.push(body);
      return json(201, body);
    }
    if (path.startsWith(`${SECRETS_PATH}/`)) {
      const name = path.slice(SECRETS_PATH.length + 1);
      const index = state.secrets.findIndex((item) => (item["metadata"] as { name: string }).name === name);
      if (index < 0) return statusFailure(404, `secrets "${name}" not found`, "NotFound");
      const secret = state.secrets[index] as Record<string, unknown>;
      if (method === "GET") return json(200, secret);
      if (method === "DELETE") {
        state.secrets.splice(index, 1);
        return json(200, { kind: "Status", status: "Success" });
      }
      if (method === "PATCH") {
        const patch = request.json() as {
          metadata?: { annotations?: Record<string, string> };
          data?: Record<string, string>;
        };
        const metadata = secret["metadata"] as { annotations?: Record<string, string> };
        metadata.annotations = { ...metadata.annotations, ...patch.metadata?.annotations };
        secret["data"] = { ...(secret["data"] as Record<string, string>), ...patch.data };
        return json(200, secret);
      }
    }

    // --- PVCs ---
    if (path === PVC_PATH && method === "POST") {
      // The API server fills `metadata.namespace` from the URL; the fake does
      // the same so the mapped read object is production-shaped.
      const body = withNamespace(request.json() as Record<string, unknown>);
      state.pvcs.push(body);
      return json(201, body);
    }
    if (path === PVC_PATH && method === "GET") {
      return json(200, { kind: "PersistentVolumeClaimList", items: state.pvcs });
    }
    if (path.startsWith(`${PVC_PATH}/`)) {
      const name = path.slice(PVC_PATH.length + 1);
      const index = state.pvcs.findIndex((item) => (item["metadata"] as { name: string }).name === name);
      if (index < 0) return statusFailure(404, `persistentvolumeclaims "${name}" not found`, "NotFound");
      const pvc = state.pvcs[index] as Record<string, unknown>;
      if (method === "GET") return json(200, pvc);
      if (method === "DELETE") {
        state.pvcs.splice(index, 1);
        return json(200, { kind: "Status", status: "Success" });
      }
      if (method === "PATCH") {
        const patch = request.json() as { metadata?: { annotations?: Record<string, string | null> } };
        const metadata = pvc["metadata"] as { annotations?: Record<string, string | null> };
        const next: Record<string, string> = { ...(metadata.annotations as Record<string, string>) };
        for (const [key, value] of Object.entries(patch.metadata?.annotations ?? {})) {
          if (value === null) delete next[key];
          else next[key] = value;
        }
        metadata.annotations = next;
        return json(200, pvc);
      }
    }
    return undefined;
  };

  return { state, handler };
}

/**
 * The adapter is configured the way a local run is configured — a kubeconfig
 * file — so the test exercises the same config path production uses, with the
 * stub's URL as the cluster server.
 */
function writeKubeconfig(serverUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "remote-agent-kubeconfig-"));
  const path = join(dir, "config");
  writeFileSync(
    path,
    `apiVersion: v1
kind: Config
clusters:
- name: stub
  cluster:
    server: ${serverUrl}
    insecure-skip-tls-verify: true
contexts:
- name: stub
  context: { cluster: stub, user: stub }
current-context: stub
users:
- name: stub
  user: { token: stub-token }
`,
  );
  return path;
}

async function adapter(world: Partial<FakeWorld> = {}) {
  const fake = fakeApi(world);
  const server = await startStubServer(fake.handler);
  stub = server;
  return {
    k8s: new KubeClientK8s({ namespace: NAMESPACE, kubeconfigPath: writeKubeconfig(server.url) }),
    state: fake.state,
    requests: () => server.requests,
  };
}

describe("KubeClientK8s: Jobs", () => {
  it("createJob POSTs the App-built manifest field for field", async () => {
    const { k8s, requests } = await adapter();
    const manifest = jobManifest("agent-2017fighting-pi-web-35");

    const created = await k8s.createJob(manifest);

    const write = requests().at(-1);
    expect(`${write?.method} ${write?.path}`).toBe(`POST ${JOB_PATH}`);
    const body = write?.json() as Record<string, any>;
    expect(body["spec"]).toMatchObject({
      parallelism: manifest.parallelism,
      backoffLimit: manifest.backoffLimit,
      activeDeadlineSeconds: manifest.activeDeadlineSeconds,
      ttlSecondsAfterFinished: manifest.ttlSecondsAfterFinished,
      podFailurePolicy: { rules: [] },
      template: {
        spec: {
          serviceAccountName: "agent-job",
          restartPolicy: "Never",
          terminationGracePeriodSeconds: 120,
          securityContext: { fsGroup: 1000 },
        },
      },
    });
    expect(created).toMatchObject({ name: manifest.name, namespace: NAMESPACE, finished: false });
  });

  it("getJob maps conditions and reads finished from Complete/Failed only", async () => {
    const { k8s } = await adapter({
      jobs: [
        {
          metadata: { name: "agent-done", namespace: NAMESPACE, labels: { "remote-agent/repo": "o/r" }, annotations: {} },
          status: { conditions: [{ type: "Complete", status: "True" }] },
        },
        {
          metadata: { name: "agent-running", namespace: NAMESPACE },
          status: { conditions: [{ type: "Suspended", status: "True" }] },
        },
      ],
    });

    expect(await k8s.getJob("agent-done")).toMatchObject({
      name: "agent-done",
      finished: true,
      labels: { "remote-agent/repo": "o/r" },
      conditions: [{ type: "Complete", status: "True" }],
    });
    expect(await k8s.getJob("agent-running")).toMatchObject({ finished: false });
    expect(await k8s.getJob("agent-missing")).toBeNull();
  });

  it("listJobs reads the namespace's Jobs", async () => {
    const { k8s } = await adapter({
      jobs: [
        { metadata: { name: "a", namespace: NAMESPACE }, status: { conditions: [] } },
        { metadata: { name: "b", namespace: NAMESPACE }, status: { conditions: [] } },
      ],
    });

    expect((await k8s.listJobs()).map((job) => job.name)).toEqual(["a", "b"]);
  });

  it("watchJobs reports ADDED and DELETED and drops the rest", async () => {
    const events = [
      JSON.stringify({ type: "ADDED", object: { metadata: { name: "a", namespace: NAMESPACE } } }),
      JSON.stringify({ type: "MODIFIED", object: { metadata: { name: "a", namespace: NAMESPACE } } }),
      JSON.stringify({ type: "DELETED", object: { metadata: { name: "a", namespace: NAMESPACE } } }),
    ];
    const { k8s } = await adapter({ watchEvents: events });
    const seen: string[] = [];

    await k8s.watchJobs((event) => seen.push(`${event.type} ${event.object.name}`));
    // The fake ends the stream; give the reader a tick to drain it.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(seen).toEqual(["ADDED a", "DELETED a"]);
  });
});

describe("KubeClientK8s: Pods and logs", () => {
  it("listPods carries owner Job, phase, Terminating and both container status lists", async () => {
    const { k8s } = await adapter({
      pods: [
        {
          metadata: {
            name: "agent-x-abcde",
            namespace: NAMESPACE,
            ownerReferences: [{ kind: "Job", name: "agent-x" }],
            deletionTimestamp: "2026-01-01T00:00:00Z",
          },
          status: {
            phase: "Failed",
            initContainerStatuses: [
              { name: "seed", state: { terminated: { reason: "Error", exitCode: 78 } } },
            ],
            containerStatuses: [{ name: "runner", state: { terminated: { reason: "OOMKilled", exitCode: 137 } } }],
          },
        },
      ],
    });

    const [pod] = await k8s.listPods();

    expect(pod).toEqual({
      name: "agent-x-abcde",
      namespace: NAMESPACE,
      ownerJobName: "agent-x",
      phase: "Failed",
      deleting: true,
      containerStatuses: [
        { name: "seed", reason: "Error", exitCode: 78 },
        { name: "runner", reason: "OOMKilled", exitCode: 137 },
      ],
    });
  });

  it("getPod returns null on 404", async () => {
    const { k8s } = await adapter();

    expect(await k8s.getPod("gone")).toBeNull();
  });

  it("getPodLog falls back to the seed container when the runner never started", async () => {
    const { k8s, state, requests } = await adapter({
      pods: [{ metadata: { name: "agent-x-abcde", namespace: NAMESPACE }, status: { phase: "Failed" } }],
    });
    state.missingContainers.add("runner");

    const log = await k8s.getPodLog("agent-x-abcde");

    expect(log).toBe("seed failed\n");
    expect(requests().filter((request) => request.path.endsWith("/log")).map((r) => r.query.get("container"))).toEqual([
      "runner",
      "seed",
    ]);
  });

  it("getPodLog reads the runner container's tail as text", async () => {
    const { k8s, requests } = await adapter({
      pods: [{ metadata: { name: "agent-x-abcde", namespace: NAMESPACE }, status: { phase: "Running" } }],
    });

    const log = await k8s.getPodLog("agent-x-abcde");

    expect(log).toBe("seed ok\nrunner: working\n");
    const read = requests().at(-1);
    expect(`${read?.method} ${read?.path}`).toBe(`GET ${PODS_PATH}/agent-x-abcde/log`);
    expect(read?.query.get("container")).toBe("runner");
  });
});

describe("KubeClientK8s: Secrets", () => {
  const secret = {
    name: "agent-x-token",
    namespace: NAMESPACE,
    annotations: { "remote-agent/token-expires-at": "2026-01-01T00:00:00Z" },
    labels: { "app.kubernetes.io/managed-by": "remote-agent" },
    data: { token: "ghs_stub" },
  };

  it("create/get/patch/delete round-trip through the API", async () => {
    const { k8s, requests } = await adapter();

    const created = await k8s.createSecret(secret);
    expect(created).toMatchObject({ name: secret.name, data: { token: "ghs_stub" } });
    // The wire body must be base64 even though the port speaks plaintext: a
    // plaintext `data` value is a 400 from the API server on every create, which
    // stops Claim before the Job exists. This assertion is the boundary.
    expect(requests().at(-1)?.json()).toMatchObject({
      metadata: { name: secret.name, annotations: secret.annotations, labels: secret.labels },
      data: { token: Buffer.from(secret.data["token"]!, "utf8").toString("base64") },
    });

    expect(await k8s.getSecret(secret.name)).toMatchObject({ name: secret.name });

    const patched = await k8s.patchSecret(secret.name, {
      data: { token: "ghs_renewed" },
      annotations: { "remote-agent/token-expires-at": "2026-01-01T01:00:00Z" },
    });
    expect(patched.data).toEqual({ token: "ghs_renewed" });
    expect(patched.annotations["remote-agent/token-expires-at"]).toBe("2026-01-01T01:00:00Z");
    // A renewal is an in-place merge patch, never a replace.
    expect(requests().at(-1)?.method).toBe("PATCH");

    await k8s.deleteSecret(secret.name);
    expect(await k8s.getSecret(secret.name)).toBeNull();
  });

  it("speaks plaintext on the port and base64 on the wire, in both directions", async () => {
    const { k8s } = await adapter();
    // A token shape k8s' base64 decoder would reject if sent raw (ADR-0009 says
    // never assume a token's shape, so this is deliberately arbitrary).
    const token = "ghs_APPID.JWT~with:odd+chars/=";

    const created = await k8s.createSecret({
      ...secret,
      data: { token },
    });
    expect(created.data).toEqual({ token });

    // getSecret decodes, so the renewal comparison sees the same plaintext the
    // mount will contain — a base64/plaintext mismatch here would re-mint every
    // pass, silently.
    expect((await k8s.getSecret(secret.name))?.data).toEqual({ token });

    const patched = await k8s.patchSecret(secret.name, { data: { token: token + "2" } });
    expect(patched.data).toEqual({ token: token + "2" });
  });

  it("patchSecret writes nothing when the patch changes nothing (replayability)", async () => {
    const { k8s, requests } = await adapter();
    await k8s.createSecret(secret);
    const before = requests().length;

    await k8s.patchSecret(secret.name, {
      data: secret.data,
      annotations: secret.annotations,
    });

    expect(requests().slice(before).filter((request) => request.method === "PATCH")).toEqual([]);
  });

  it("patchSecret on a missing Secret is NotFound, not a silent create", async () => {
    const { k8s } = await adapter();

    const error = await k8s.patchSecret("absent", { data: { token: "x" } }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(K8sApiError);
    expect(isNotFound(error)).toBe(true);
  });

  it("getSecret returns null on 404", async () => {
    const { k8s } = await adapter();

    expect(await k8s.getSecret("absent")).toBeNull();
  });
});

describe("KubeClientK8s: Ticket PVCs", () => {
  it("createPvc carries accessMode, storage class and the 8Gi request", async () => {
    const { k8s, requests } = await adapter();
    const manifest = pvcManifest("agent-x");

    const created = await k8s.createPvc(manifest);

    expect(created).toMatchObject({ name: "agent-x", namespace: NAMESPACE });
    expect(requests().at(-1)?.json()).toMatchObject({
      metadata: { name: "agent-x" },
      spec: {
        accessModes: ["ReadWriteOncePod"],
        storageClassName: "truenas-iscsi-delete",
        resources: { requests: { storage: "8Gi" } },
      },
    });
  });

  it("get/list/patch/clear/delete round-trip", async () => {
    const { k8s, requests } = await adapter();
    await k8s.createPvc(pvcManifest("agent-x"));

    expect((await k8s.listPvcs()).map((pvc) => pvc.name)).toEqual(["agent-x"]);

    const stamped = await k8s.patchPvcAnnotations("agent-x", { "remote-agent/expires-at": "2026-01-08T00:00:00Z" });
    expect(stamped.annotations["remote-agent/expires-at"]).toBe("2026-01-08T00:00:00Z");

    const cleared = await k8s.clearPvcAnnotation("agent-x", "remote-agent/expires-at");
    expect(cleared.annotations["remote-agent/expires-at"]).toBeUndefined();

    // Absent key and identical annotations are both no-writes.
    const writesBefore = requests().filter((request) => request.method === "PATCH").length;
    await k8s.clearPvcAnnotation("agent-x", "remote-agent/expires-at");
    await k8s.patchPvcAnnotations("agent-x", { "remote-agent/expires-at": "2026-01-08T00:00:00Z" });
    await k8s.patchPvcAnnotations("agent-x", { "remote-agent/expires-at": "2026-01-08T00:00:00Z" });
    expect(requests().filter((request) => request.method === "PATCH").length).toBe(writesBefore + 1);

    await k8s.deletePvc("agent-x");
    expect(await k8s.getPvc("agent-x")).toBeNull();
  });
});

describe("KubeClientK8s: error mapping (the decision layer branches on these)", () => {
  it("409 on create is AlreadyExists — create-if-absent treats it as success", async () => {
    const { k8s, state } = await adapter();
    state.failures.set(`POST ${JOB_PATH}`, () =>
      statusFailure(409, 'jobs.batch "agent-x" already exists', "AlreadyExists"),
    );

    const error = await k8s.createJob(jobManifest("agent-x")).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(K8sApiError);
    expect((error as K8sApiError).status).toBe(409);
    expect(isAlreadyExists(error)).toBe(true);
    // And it must not be mistaken for the other two classes.
    expect(isQuotaExceeded(error)).toBe(false);
    expect(isNotFound(error)).toBe(false);
  });

  it("403 quota exceeded is QuotaExceeded — a normal branch, not an error", async () => {
    const { k8s, state } = await adapter();
    state.failures.set(`POST ${JOB_PATH}`, () =>
      statusFailure(
        403,
        'exceeded quota: remote-agent-quota, requested: count/jobs.batch=1, used: count/jobs.batch=10, limited: count/jobs.batch=10',
        "Forbidden",
      ),
    );

    const error = await k8s.createJob(jobManifest("agent-x")).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(K8sApiError);
    expect((error as K8sApiError).status).toBe(403);
    expect(isQuotaExceeded(error)).toBe(true);
    expect(isAlreadyExists(error)).toBe(false);
  });

  it("a plain 403 (missing RBAC verb) is NOT QuotaExceeded — it must fail loudly", async () => {
    const { k8s, state } = await adapter();
    state.failures.set(`POST ${PVC_PATH}`, () =>
      statusFailure(
        403,
        'persistentvolumeclaims is forbidden: User "system:serviceaccount:remote-agent:remote-agent" cannot create resource "persistentvolumeclaims" in API group "" in the namespace "remote-agent"',
        "Forbidden",
      ),
    );

    const error = await k8s.createPvc(pvcManifest("agent-x")).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(K8sApiError);
    expect((error as K8sApiError).status).toBe(403);
    // The guardrail predicate must not swallow an RBAC failure.
    expect(isQuotaExceeded(error)).toBe(false);
    expect((error as Error).message).toContain("is forbidden");
  });

  it("404 on delete is NotFound — reclamation treats it as already gone", async () => {
    const { k8s, state } = await adapter();
    state.failures.set(`DELETE ${PVC_PATH}/agent-x`, () =>
      statusFailure(404, 'persistentvolumeclaims "agent-x" not found', "NotFound"),
    );

    const error = await k8s.deletePvc("agent-x").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(K8sApiError);
    expect((error as K8sApiError).status).toBe(404);
    expect(isNotFound(error)).toBe(true);
  });

  it("a transport failure stays a plain Error (never dressed up as a k8s status)", async () => {
    const { k8s } = await adapter();
    await stub?.close();
    stub = undefined;

    const error = await k8s.listJobs().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(K8sApiError);
  });
});
