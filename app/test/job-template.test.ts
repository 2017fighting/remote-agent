import { describe, expect, it } from "vitest";
import { JOB_ENV_KEYS, jobName, secretName, VOLUME_PATHS } from "@remote-agent/shared";
import { runReconcilePass } from "../src/reconcile.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import type { K8sJobManifest } from "../src/ports/K8sPort.js";
import { JOB_IMAGE } from "../src/job-image.js";
import {
  JOB_ONLY_ENV_KEYS,
  TOKEN_MOUNT_PATH,
  TOKEN_SECRET_KEY,
  renderJobManifest,
} from "../src/renders/job-template.js";
import { testConfig } from "./helpers.js";
import { REPO, specWorld } from "./world.js";

/**
 * The Job object's decision surface (spec #33 §4, ADR-0010 / ADR-0012):
 * image, env keys, volumes/mounts, the seven budget numbers,
 * `podFailurePolicy`, TTL and labels. Not every pod-spec field — only the ones
 * a decision depends on (spec #33 Testing Decisions: "明确不在测试范围内").
 */

const config = testConfig();

function manifest(): K8sJobManifest {
  return renderJobManifest({
    config,
    targetRepo: REPO,
    issueNumber: 35,
    specNumber: 33,
    role: "implement-ticket",
    workItemJson: '{"repo":"2017fighting/remote-agent"}',
  });
}

describe("job template: identity and labels", () => {
  it("is named `agent-<repo-slug>-<issue#>` with the PVC and Secret derived from it", () => {
    const job = manifest();
    expect(job.name).toBe("agent-2017fighting-remote-agent-35");
    expect(job.name).toBe(jobName(REPO, 35));
    expect(job.name.length).toBeLessThanOrEqual(63);
    expect(job.podTemplate.volumes).toContainEqual({
      name: "ticket",
      persistentVolumeClaim: { claimName: jobName(REPO, 35) },
    });
    expect(job.podTemplate.volumes).toContainEqual({
      name: "token",
      secret: { secretName: secretName(REPO, 35) },
    });
  });

  it("carries the provenance label surface", () => {
    expect(manifest().labels).toEqual({
      "app.kubernetes.io/managed-by": "remote-agent",
      "remote-agent/ticket": `${REPO}#35`,
      "remote-agent/spec": "33",
      "remote-agent/repo": REPO,
      "remote-agent/role": "implement-ticket",
    });
  });

  it("puts the role in the label, not in the name", () => {
    const ticket = manifest();
    const spec = renderJobManifest({
      config,
      targetRepo: REPO,
      issueNumber: 33,
      specNumber: 33,
      role: "implement-spec",
      workItemJson: "{}",
    });
    expect(spec.name).toBe(jobName(REPO, 33));
    expect(spec.labels["remote-agent/role"]).toBe("implement-spec");
    expect(ticket.labels["remote-agent/role"]).toBe("implement-ticket");
  });

  it("runs the baked Job image in both containers", () => {
    const job = manifest();
    expect(job.podTemplate.initContainers[0]!.image).toBe(JOB_IMAGE);
    expect(job.podTemplate.containers[0]!.image).toBe(JOB_IMAGE);
  });
});

describe("job template: env key surface", () => {
  it("injects the documented Job env keys", () => {
    const env = manifest().podTemplate.containers[0]!.env!;
    const names = env.map((e) => e.name);
    expect(names).toEqual([
      JOB_ENV_KEYS.agentRole,
      JOB_ENV_KEYS.agentThinkingLevel,
      JOB_ENV_KEYS.agentWorkItem,
      JOB_ENV_KEYS.targetRepo,
      JOB_ENV_KEYS.specNumber,
      JOB_ENV_KEYS.gitBaseUrl,
      JOB_ONLY_ENV_KEYS.gitRemoteUrl,
      JOB_ENV_KEYS.githubAppId,
      JOB_ENV_KEYS.omniRouteBaseUrl,
      JOB_ENV_KEYS.omniRouteModel,
      JOB_ENV_KEYS.omniRouteReviewModel,
      JOB_ENV_KEYS.omniRouteApiKey,
      JOB_ENV_KEYS.jobName,
      JOB_ENV_KEYS.jobNamespace,
    ]);
  });

  it("emits JOB_NAME and JOB_NAMESPACE with the sources the runner can trust", () => {
    // The declared Job env surface and what the template emits must be the same
    // set: the runner writes its run result on its own Job (ADR-0007), so both
    // identifiers are part of the Job contract.
    const env = manifest().podTemplate.containers[0]!.env!;

    // The namespace is the pod's own, which the downward API reports.
    expect(env).toContainEqual({
      name: JOB_ENV_KEYS.jobNamespace,
      valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } },
    });
    expect(env.filter((e) => e.valueFrom !== undefined).map((e) => e.name)).toEqual([JOB_ENV_KEYS.jobNamespace]);

    // The Job name is a literal: downward-API `metadata.name` is the *pod* name.
    expect(env).toContainEqual({ name: JOB_ENV_KEYS.jobName, value: jobName(REPO, 35) });
  });

  it("emits the Job name, never the pod name that `fieldRef: metadata.name` would give", () => {
    // `deriveJobName()` in the runner prefers `JOB_NAME` over the deterministic
    // rule, so a pod-style value (`<job>-abcde`) would make the run-result PATCH
    // target a Job that does not exist. Pinning the value here makes a future
    // switch back to `fieldRef: metadata.name` fail loudly instead of silently
    // breaking every annotation write.
    const env = new Map(manifest().podTemplate.containers[0]!.env!.map((e) => [e.name, e]));
    const emitted = env.get(JOB_ENV_KEYS.jobName)!;
    expect(emitted.value).toBe(jobName(REPO, 35));
    expect(emitted.value).toBe(manifest().name);
    expect(emitted.valueFrom).toBeUndefined();
    expect(emitted.value).not.toMatch(/-[a-z0-9]{5}$/);
  });

  it("declares exactly the env keys it emits", () => {
    // No declared-but-unemitted key (a runner fallback that is never exercised)
    // and no emitted-but-undeclared key (a key with no contract). This is the
    // assertion that keeps the surface self-enforcing for every future key.
    const emitted = manifest().podTemplate.containers[0]!.env!.map((e) => e.name).sort();
    const declared = Object.values(JOB_ENV_KEYS).sort();
    expect(emitted).toEqual(declared);
    expect(emitted).toHaveLength(14);
  });

  it("emits GITHUB_APP_ID so agent commits carry the bot identity (ADR-0009)", () => {
    const env = new Map(manifest().podTemplate.containers[0]!.env!.map((e) => [e.name, e]));
    expect(env.get(JOB_ENV_KEYS.githubAppId)?.value).toBe("");

    const withAppId = renderJobManifest({
      config: testConfig({ GITHUB_APP_ID: "5390512" }),
      targetRepo: REPO,
      issueNumber: 35,
      specNumber: 33,
      role: "implement-ticket",
      workItemJson: "{}",
    });
    const appIdEnv = new Map(withAppId.podTemplate.containers[0]!.env!.map((e) => [e.name, e]));
    expect(appIdEnv.get(JOB_ENV_KEYS.githubAppId)?.value).toBe("5390512");
  });

  it("sets the role, thinking level, work item and target repo values", () => {
    const env = new Map(manifest().podTemplate.containers[0]!.env!.map((e) => [e.name, e]));
    expect(env.get(JOB_ENV_KEYS.agentRole)?.value).toBe("implement-ticket");
    expect(env.get(JOB_ENV_KEYS.agentThinkingLevel)?.value).toBe("high");
    expect(env.get(JOB_ENV_KEYS.agentWorkItem)?.value).toBe('{"repo":"2017fighting/remote-agent"}');
    expect(env.get(JOB_ENV_KEYS.targetRepo)?.value).toBe(REPO);
    expect(env.get(JOB_ENV_KEYS.specNumber)?.value).toBe("33");
  });

  it("composes the target repo clone URL from GIT_BASE_URL (no token in the URL)", () => {
    const env = new Map(manifest().podTemplate.containers[0]!.env!.map((e) => [e.name, e]));
    expect(env.get(JOB_ENV_KEYS.gitBaseUrl)?.value).toBe("https://github.com");
    expect(env.get(JOB_ONLY_ENV_KEYS.gitRemoteUrl)?.value).toBe(`https://github.com/${REPO}.git`);

    const stub = renderJobManifest({
      config: testConfig({ GIT_BASE_URL: "http://stub-git.svc/" }),
      targetRepo: REPO,
      issueNumber: 35,
      specNumber: 33,
      role: "implement-ticket",
      workItemJson: "{}",
    });
    const stubEnv = new Map(stub.podTemplate.containers[0]!.env!.map((e) => [e.name, e]));
    expect(stubEnv.get(JOB_ONLY_ENV_KEYS.gitRemoteUrl)?.value).toBe(`http://stub-git.svc/${REPO}.git`);
  });

  it("takes OMNIROUTE_API_KEY from exactly one secret key, never envFrom", () => {
    const apiKey = manifest().podTemplate.containers[0]!.env!.find(
      (e) => e.name === JOB_ENV_KEYS.omniRouteApiKey,
    );
    expect(apiKey).toEqual({
      name: JOB_ENV_KEYS.omniRouteApiKey,
      secretKeyRef: { name: "remote-agent-secret", key: "OMNIROUTE_API_KEY" },
    });
    expect(manifest().podTemplate.containers[0]!.env!.filter((e) => e.secretKeyRef)).toHaveLength(1);
  });

  it("gives the seed container only what it needs to seed (no work item, no model config)", () => {
    const names = manifest().podTemplate.initContainers[0]!.env!.map((e) => e.name);
    expect(names).toEqual([JOB_ENV_KEYS.targetRepo, JOB_ENV_KEYS.specNumber, JOB_ONLY_ENV_KEYS.gitRemoteUrl]);
  });
});

describe("job template: volumes and mounts", () => {
  it("mounts the Ticket PVC at the layout root for both containers", () => {
    const job = manifest();
    expect(job.podTemplate.initContainers[0]!.volumeMounts).toContainEqual({
      name: "ticket",
      mountPath: VOLUME_PATHS.mountRoot,
    });
    const agentMounts = job.podTemplate.containers[0]!.volumeMounts!;
    expect(agentMounts).toContainEqual({ name: "ticket", mountPath: VOLUME_PATHS.mountRoot });
    // repo/, state/ and home/ are directories under that one mount.
    expect(VOLUME_PATHS.repo.startsWith(`${VOLUME_PATHS.mountRoot}/`)).toBe(true);
    expect(VOLUME_PATHS.state.startsWith(`${VOLUME_PATHS.mountRoot}/`)).toBe(true);
    expect(VOLUME_PATHS.home.startsWith(`${VOLUME_PATHS.mountRoot}/`)).toBe(true);
  });

  it("mounts the token Secret as a read-only file path, never as env", () => {
    const mounts = manifest().podTemplate.containers[0]!.volumeMounts!;
    expect(mounts).toContainEqual({
      name: "token",
      mountPath: TOKEN_MOUNT_PATH,
      subPath: TOKEN_SECRET_KEY,
      readOnly: true,
    });
  });
});

describe("job template: the seven budget numbers", () => {
  it("applies the ADR-0010 / ADR-0012 values", () => {
    const job = manifest();
    const agent = job.podTemplate.containers[0]!;
    const seed = job.podTemplate.initContainers[0]!;
    expect(config.jobPvcSize).toBe("8Gi");
    expect(agent.resources).toEqual({ requests: { cpu: "500m", memory: "2Gi" }, limits: { memory: "6Gi" } });
    expect(seed.resources).toEqual({ requests: { cpu: "100m", memory: "128Mi" } });
    expect(seed.resources?.limits).toBeUndefined();
    expect(job.activeDeadlineSeconds).toBe(10800);
    expect(job.backoffLimit).toBe(4);
    expect(job.podTemplate.terminationGracePeriodSeconds).toBe(120);
    expect(job.ttlSecondsAfterFinished).toBe(1800);
  });

  it("reads the four env-overridable numbers from App config", () => {
    const overridden = renderJobManifest({
      config: testConfig({
        JOB_PVC_SIZE: "12Gi",
        JOB_ACTIVE_DEADLINE_SECONDS: "3600",
        JOB_BACKOFF_LIMIT: "2",
        JOB_TTL_SECONDS_AFTER_FINISHED: "600",
      }),
      targetRepo: REPO,
      issueNumber: 35,
      specNumber: 33,
      role: "implement-ticket",
      workItemJson: "{}",
    });
    expect(overridden.activeDeadlineSeconds).toBe(3600);
    expect(overridden.backoffLimit).toBe(2);
    expect(overridden.ttlSecondsAfterFinished).toBe(600);
    expect(testConfig({ JOB_PVC_SIZE: "12Gi" }).jobPvcSize).toBe("12Gi");
  });

  it("keeps CPU unlimited and only caps memory (ADR-0010: CFS throttling would stretch builds)", () => {
    const agent = manifest().podTemplate.containers[0]!;
    expect(agent.resources?.limits?.cpu).toBeUndefined();
    expect(agent.resources?.limits?.memory).toBe("6Gi");
  });
});

describe("job template: podFailurePolicy, restart policy, scheduling", () => {
  it("fails the Job immediately when the seed container exits 78", () => {
    expect(manifest().podFailurePolicy).toEqual({
      rules: [
        {
          action: "FailJob",
          onExitCodes: { containerName: "seed", operator: "In", values: [78] },
        },
      ],
    });
  });

  it("uses restartPolicy Never (required by podFailurePolicy) and parallelism 1", () => {
    const job = manifest();
    expect(job.podTemplate.restartPolicy).toBe("Never");
    expect(job.parallelism).toBe(1);
  });

  it("sets pod-level fsGroup 1000 so git and the agent share a uid", () => {
    expect(manifest().podTemplate.securityContext).toEqual({ fsGroup: 1000 });
  });

  it("runs under the shared agent-job ServiceAccount", () => {
    expect(manifest().podTemplate.serviceAccountName).toBe("agent-job");
  });
});

describe("Ticket PVC created at claim", () => {
  it("is ReadWriteOncePod on truenas-iscsi-delete with the configured size and provenance labels", async () => {
    const github = specWorld({ specNumber: 33, subIssueNumbers: [35] });
    const k8s = new FakeK8s();
    await runReconcilePass({ github, k8s, config }, "webhook");

    const pvc = k8s.pvcManifests[0]!;
    expect(pvc.name).toBe(jobName(REPO, 35));
    expect(pvc.spec).toEqual({
      accessModes: ["ReadWriteOncePod"],
      storageClassName: "truenas-iscsi-delete",
      resources: { requests: { storage: "8Gi" } },
    });
    expect(pvc.labels).toEqual({
      "app.kubernetes.io/managed-by": "remote-agent",
      "remote-agent/ticket": `${REPO}#35`,
      "remote-agent/spec": "33",
    });
  });
});
