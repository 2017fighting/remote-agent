import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  APP_SECRET,
  APP_SERVICE_ACCOUNT,
  JOB_SERVICE_ACCOUNT,
  NAMESPACE,
  PROMPTS_OVERRIDE_CONFIGMAP,
  renderAppDeployment,
  renderAppRbac,
  renderAppSecret,
  renderJobRbac,
  renderPromptsOverrideConfigMap,
  renderResourceQuota,
  renderTicketStorageClass,
} from "../src/manifests.js";

/**
 * The harness's namespace contract, pinned to docs/deployment.md.
 *
 * These are pure functions, so they are testable without a cluster — and they
 * must be, because the RBAC here is the deployed permission surface: a verb that
 * drifts makes the kind e2e pass against a world production would refuse. The
 * assertions quote the docs' table rather than restating the code.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface RoleRule {
  apiGroups: string[];
  resources: string[];
  verbs: string[];
}

function rulesOf(manifest: Record<string, unknown>): RoleRule[] {
  return (manifest as { rules: RoleRule[] }).rules;
}

function verbsFor(rules: RoleRule[], resource: string): string[] {
  return rules.find((rule) => rule.resources.includes(resource))?.verbs ?? [];
}

describe("harness manifests: App RBAC (docs/deployment.md §4)", () => {
  const manifests = renderAppRbac();
  const role = manifests.find((manifest) => manifest["kind"] === "Role")!;

  it("creates the App ServiceAccount in the one namespace", () => {
    const serviceAccount = manifests.find((manifest) => manifest["kind"] === "ServiceAccount")!;
    expect((serviceAccount["metadata"] as { name: string }).name).toBe(APP_SERVICE_ACCOUNT);
    expect((serviceAccount["metadata"] as { namespace: string }).namespace).toBe(NAMESPACE);
    expect(serviceAccount["automountServiceAccountToken"]).toBe(true);
  });

  it("grants exactly the documented verbs on each resource", () => {
    const rules = rulesOf(role);
    expect(verbsFor(rules, "jobs")).toEqual(["create", "get", "list", "watch"]);
    expect(verbsFor(rules, "pods")).toEqual(["get", "list"]);
    expect(verbsFor(rules, "pods/log")).toEqual(["get"]);
    expect(verbsFor(rules, "secrets")).toEqual(["create", "get", "patch", "delete"]);
    expect(verbsFor(rules, "persistentvolumeclaims")).toEqual(["create", "get", "list", "patch", "delete"]);
  });

  it("withholds the verbs the docs explicitly deny", () => {
    const rules = rulesOf(role);
    // k8s is the only Job deleter (ADR-0012); the App does not patch Jobs.
    expect(verbsFor(rules, "jobs")).not.toContain("delete");
    expect(verbsFor(rules, "jobs")).not.toContain("patch");
    // The sandbox split rules out pods/exec (ADR-0008).
    expect(rules.some((rule) => rule.resources.includes("pods/exec"))).toBe(false);
  });

  it("binds the Role to its ServiceAccount", () => {
    const binding = manifests.find((manifest) => manifest["kind"] === "RoleBinding")!;
    expect(binding["subjects"]).toEqual([
      { kind: "ServiceAccount", name: APP_SERVICE_ACCOUNT, namespace: NAMESPACE },
    ]);
    expect(binding["roleRef"]).toMatchObject({ kind: "Role", name: APP_SERVICE_ACCOUNT });
  });
});

describe("harness manifests: Job RBAC (docs/deployment.md §5)", () => {
  const manifests = renderJobRbac();
  const role = manifests.find((manifest) => manifest["kind"] === "Role")!;

  it("gives the shared agent-job SA jobs get and patch only", () => {
    const rules = rulesOf(role);
    expect(rules).toEqual([{ apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "patch"] }]);
    const serviceAccount = manifests.find((manifest) => manifest["kind"] === "ServiceAccount")!;
    expect((serviceAccount["metadata"] as { name: string }).name).toBe(JOB_SERVICE_ACCOUNT);
  });
});

describe("harness manifests: quota, storage class, prompts", () => {
  it("counts objects only, never resources (docs/deployment.md §7)", () => {
    const quota = renderResourceQuota() as { spec: { hard: Record<string, string> } };
    expect(quota.spec.hard).toEqual({ "count/jobs.batch": "10", pods: "20" });
    // Any requests.* / limits.* key would make k8s demand declarations from every pod.
    expect(Object.keys(quota.spec.hard).some((key) => /requests\.|limits\./.test(key))).toBe(false);
  });

  it("supplies the storage class name the App's template requires", () => {
    const storageClass = renderTicketStorageClass() as {
      metadata: { name: string };
      reclaimPolicy: string;
      provisioner: string;
    };
    // app/src/renders/job-template.ts hardcodes this name; the cluster adapts.
    expect(storageClass.metadata.name).toBe("truenas-iscsi-delete");
    expect(storageClass.reclaimPolicy).toBe("Delete");
    expect(storageClass.provisioner).not.toBe("");
  });

  it("builds the prompt override ConfigMap with only `_common` from prompts/ (ADR-0020)", async () => {
    const configMap = (await renderPromptsOverrideConfigMap(join(repoRoot, "prompts"))) as {
      metadata: { name: string };
      data: Record<string, string>;
    };
    expect(configMap.metadata.name).toBe(PROMPTS_OVERRIDE_CONFIGMAP);
    // Only `_common`, so the run must fall back to the image for every other key.
    expect(Object.keys(configMap.data)).toEqual(["_common"]);
    // Verbatim from the repo, not a fixture copy.
    const onDisk = await readFile(join(repoRoot, "prompts", "_common"), "utf8");
    expect(configMap.data["_common"]).toBe(onDisk);
  });
});

describe("harness manifests: App Deployment env is the whole test difference", () => {
  const deployment = renderAppDeployment({
    image: "remote-agent-e2e/app:local",
    stubGitHubUrl: "http://stub-github:8080",
    stubModelUrl: "http://stub-model:8080/v1",
    targetRepo: "2017fighting/remote-agent",
  }) as {
    spec: {
      replicas: number;
      template: {
        spec: {
          serviceAccountName: string;
          containers: Array<{
            env: Array<{
              name: string;
              value?: string;
              valueFrom?: { secretKeyRef?: { name: string; key: string } };
            }>;
          }>;
        };
      };
    };
  };
  const env = Object.fromEntries(
    deployment.spec.template.spec.containers[0]!.env.map((entry) => [entry.name, entry]),
  );

  it("points the three base URLs at the stubs and nothing else at a test-only value", () => {
    expect(env["GITHUB_API_BASE_URL"]?.value).toBe("http://stub-github:8080");
    expect(env["GIT_BASE_URL"]?.value).toBe("http://stub-github:8080");
    expect(env["OMNIROUTE_BASE_URL"]?.value).toBe("http://stub-model:8080/v1");
    expect(env["NAMESPACE"]?.value).toBe(NAMESPACE);
    expect(deployment.spec.template.spec.serviceAccountName).toBe(APP_SERVICE_ACCOUNT);
    // One replica, no database (docs/deployment.md §1).
    expect(deployment.spec.replicas).toBe(1);
  });

  it("feeds both credentials from the Secret, as production does", () => {
    // A literal here would hide a missing Secret key: the App would boot against
    // a value only the e2e has. Production reads `remote-agent-secret` (§3).
    for (const key of ["GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"]) {
      expect(env[key]?.value).toBeUndefined();
      expect(env[key]?.valueFrom?.secretKeyRef).toEqual({ name: APP_SECRET, key });
    }
  });
});

describe("harness manifests: the one Secret (docs/deployment.md §3)", () => {
  it("carries exactly the three keys the docs list, and the App reads two of them", () => {
    const secret = renderAppSecret({
      privateKey: "pem",
      webhookSecret: "secret",
      omniRouteApiKey: "key",
    }) as { metadata: { name: string }; stringData: Record<string, string> };
    expect(secret.metadata.name).toBe(APP_SECRET);
    expect(Object.keys(secret.stringData).sort()).toEqual([
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_WEBHOOK_SECRET",
      "OMNIROUTE_API_KEY",
    ]);
  });
});
