import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/main.js";
import { json, startStubServer, type StubRequest, type StubServer } from "./http-stub.js";

/**
 * The App wired to the *production* adapters, both pointed at local stubs
 * (spec #43: "The App process starts against the adapters and reaches its
 * startup list without throwing"). This is the seam where a stub-only unit test
 * cannot see a mismatch — a real `OctokitGitHub` + `KubeClientK8s` behind the
 * scheduler's startup list and first pass.
 */

const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const NAMESPACE = "remote-agent";
const OWNER = "2017fighting";
const NAME = "pi-web";

let servers: StubServer[] = [];

afterEach(async () => {
  for (const server of servers) await server.close();
  servers = [];
});

function githubStub(): Promise<StubServer> {
  return startStubServer((request: StubRequest) => {
    if (request.method === "GET" && request.path === "/app/installations") {
      return json(200, [{ id: 4242 }]);
    }
    if (request.method === "POST" && request.path === "/app/installations/4242/access_tokens") {
      return json(201, { token: "ghs_stub", expires_at: "2026-01-01T00:00:00Z" });
    }
    if (request.method === "GET" && request.path === "/installation/repositories") {
      return json(200, { total_count: 1, repositories: [{ id: 1, name: NAME, full_name: `${OWNER}/${NAME}` }] });
    }
    if (request.method === "GET" && request.path === `/repos/${OWNER}/${NAME}/issues`) {
      return json(200, []);
    }
    return undefined;
  });
}

function k8sStub(): Promise<StubServer> {
  return startStubServer((request: StubRequest) => {
    const empty = { kind: "List", items: [] };
    if (request.path === `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`) return json(200, empty);
    if (request.path === `/api/v1/namespaces/${NAMESPACE}/pods`) return json(200, empty);
    if (request.path === `/api/v1/namespaces/${NAMESPACE}/persistentvolumeclaims`) return json(200, empty);
    return undefined;
  });
}

function kubeconfigFor(serverUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "remote-agent-wiring-"));
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

describe("App on the production adapters", () => {
  it("startup list and the first pass complete against the adapters", async () => {
    const githubServer = await githubStub();
    const k8sServer = await k8sStub();
    servers.push(githubServer, k8sServer);

    // The k8s client reads KUBECONFIG itself (same path `kubectl` uses), so the
    // stub is selected exactly the way a local run selects a cluster.
    const previousKubeconfig = process.env["KUBECONFIG"];
    process.env["KUBECONFIG"] = kubeconfigFor(k8sServer.url);
    const logLines: string[] = [];
    const app = await startApp({
      env: {
        GITHUB_APP_ID: "5390512",
        GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
        GITHUB_API_BASE_URL: githubServer.url,
        NAMESPACE,
      },
      log: (line) => logLines.push(line),
      webhookSecret: "wiring-secret",
    });
    try {
      // The startup list and the pass's world read both went through the
      // adapter: JWT → installation token once, then the token is reused.
      expect(githubServer.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        "GET /app/installations",
        "POST /app/installations/4242/access_tokens",
        "GET /installation/repositories",
        `GET /repos/${OWNER}/${NAME}/issues`,
        "GET /app/installations",
        "GET /installation/repositories",
        `GET /repos/${OWNER}/${NAME}/issues`,
      ]);
      // …and the pass read the world from k8s through the adapter, then logged.
      expect(k8sServer.requests.map((request) => request.path)).toEqual(
        expect.arrayContaining([
          `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`,
          `/api/v1/namespaces/${NAMESPACE}/pods`,
          `/api/v1/namespaces/${NAMESPACE}/persistentvolumeclaims`,
        ]),
      );
      expect(logLines).toContain("pass trigger=startup slots=0/3 deferred=0 renewed=0 waiting=0 idle=0");
      // An empty world is also a write-free world: the only non-GET request is
      // the one token mint the installation client needed.
      expect(githubServer.requests.filter((request) => request.method !== "GET")).toHaveLength(1);
    } finally {
      await app.stop();
      if (previousKubeconfig === undefined) delete process.env["KUBECONFIG"];
      else process.env["KUBECONFIG"] = previousKubeconfig;
    }
  });
});
