import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  APP_SERVICE_ACCOUNT,
  JOB_SERVICE_ACCOUNT,
  NAMESPACE,
  PROMPT_KEYS,
  PROMPTS_CONFIGMAP,
  renderAppDeployment,
  renderAppRbac,
  renderJobRbac,
  renderPromptsConfigMap,
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

  it("builds the prompts ConfigMap with exactly the five keys from prompts/", async () => {
    const configMap = (await renderPromptsConfigMap(join(repoRoot, "prompts"))) as {
      metadata: { name: string };
      data: Record<string, string>;
    };
    expect(configMap.metadata.name).toBe(PROMPTS_CONFIGMAP);
    expect(Object.keys(configMap.data).sort()).toEqual([...PROMPT_KEYS].sort());
    // Verbatim from the repo, not a fixture copy (ADR-0004: text is the ConfigMap's).
    for (const key of PROMPT_KEYS) {
      const onDisk = await readFile(join(repoRoot, "prompts", key), "utf8");
      expect(configMap.data[key]).toBe(onDisk);
    }
  });
});

describe("harness manifests: App Deployment env is the whole test difference", () => {
  it("points the three base URLs at the stubs and nothing else at a test-only value", () => {
    const deployment = renderAppDeployment({
      image: "remote-agent-e2e/app:local",
      stubGitHubUrl: "http://stub-github:8080",
      stubModelUrl: "http://stub-model:8080/v1",
      targetRepo: "2017fighting/remote-agent",
      webhookSecret: "s",
    }) as {
      spec: {
        replicas: number;
        template: {
          spec: {
            serviceAccountName: string;
            containers: Array<{ env: Array<{ name: string; value?: string }> }>;
          };
        };
      };
    };
    const env = Object.fromEntries(
      deployment.spec.template.spec.containers[0]!.env.map((entry) => [entry.name, entry.value]),
    );
    expect(env["GITHUB_API_BASE_URL"]).toBe("http://stub-github:8080");
    expect(env["GIT_BASE_URL"]).toBe("http://stub-github:8080");
    expect(env["OMNIROUTE_BASE_URL"]).toBe("http://stub-model:8080/v1");
    expect(env["NAMESPACE"]).toBe(NAMESPACE);
    expect(deployment.spec.template.spec.serviceAccountName).toBe(APP_SERVICE_ACCOUNT);
    // One replica, no database (docs/deployment.md §1).
    expect(deployment.spec.replicas).toBe(1);
  });
});
