import { describe, expect, it } from "vitest";
import { ANNOTATIONS, jobName, secretName } from "@remote-agent/shared";
import { runReconcilePass } from "../src/reconcile.js";
import { FakeK8s } from "../src/fakes/FakeK8s.js";
import { TOKEN_MOUNT_PATH } from "../src/renders/job-template.js";
import { testConfig } from "./helpers.js";
import { GATE_LABELS, REPO, specWorld } from "./world.js";

/**
 * Per-Job credential (ADR-0009): an installation token scoped to the target
 * repo with `contents: write` only, written into `agent-<repo-slug>-<issue#>-token`
 * with GitHub's `expires_at` on `remote-agent/token-expires-at`. This file pins
 * the mint-at-Claim half; renewal lives in token-renewal.test.ts.
 */

const config = testConfig();

function oneTicket() {
  return { github: specWorld({ specNumber: 33, subIssueNumbers: [35] }), k8s: new FakeK8s() };
}

describe("token steward: mint at claim", () => {
  it("writes the Secret under the deterministic name with the expiry annotation", async () => {
    const { github, k8s } = oneTicket();
    await runReconcilePass({ github, k8s, config }, "webhook");

    const secret = k8s.secrets[0]!;
    expect(secret.name).toBe(secretName(REPO, 35));
    expect(secret.name).toBe(`${jobName(REPO, 35)}-token`);
    expect(secret.namespace).toBe("remote-agent");
    // The value is GitHub's own `expires_at`, not something derived from a clock.
    expect(secret.annotations[ANNOTATIONS.tokenExpiresAt]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(secret.data["token"]).toMatch(/^ghs_/);
  });

  it("mints one token per claim, scoped to the target repo", async () => {
    const { github, k8s } = oneTicket();
    await runReconcilePass({ github, k8s, config }, "webhook");
    expect(github.writeLog.filter((w) => w.startsWith("mintInstallationToken"))).toEqual([
      `mintInstallationToken ${REPO}`,
    ]);
  });

  it("carries the provenance surface: legal labels, identity in the annotations", async () => {
    const { github, k8s } = oneTicket();
    await runReconcilePass({ github, k8s, config }, "webhook");
    expect(k8s.secrets[0]!.labels).toEqual({
      "app.kubernetes.io/managed-by": "remote-agent",
      "remote-agent/spec": "33",
    });
    expect(k8s.secrets[0]!.annotations).toEqual({
      "remote-agent/repo": REPO,
      "remote-agent/ticket": `${REPO}#35`,
      "remote-agent/token-expires-at": expect.any(String),
    });
  });

  it("mints nothing when the Secret is already there", async () => {
    const github = specWorld({ specNumber: 33, subIssueNumbers: [35] });
    const k8s = new FakeK8s({
      secrets: [
        {
          name: secretName(REPO, 35),
          namespace: "remote-agent",
          annotations: { [ANNOTATIONS.tokenExpiresAt]: "2025-01-01T00:00:00Z" },
          labels: {},
          data: { token: "existing" },
        },
      ],
    });
    await runReconcilePass({ github, k8s, config }, "webhook");
    expect(github.writeLog.filter((w) => w.startsWith("mintInstallationToken"))).toEqual([]);
    expect(k8s.secrets[0]!.data["token"]).toBe("existing");
  });

  it("is mounted as a file, never injected as an env var", async () => {
    const { github, k8s } = oneTicket();
    await runReconcilePass({ github, k8s, config }, "webhook");
    const job = k8s.jobManifests[0]!;
    expect(job.podTemplate.volumes).toContainEqual({
      name: "token",
      secret: { secretName: secretName(REPO, 35) },
    });
    expect(TOKEN_MOUNT_PATH.startsWith("/mnt/")).toBe(true);
    const envNames = job.podTemplate.containers[0]!.env!.map((e) => e.name);
    expect(envNames).not.toContain("GITHUB_TOKEN");
    expect(envNames).not.toContain("TOKEN");
  });
});

describe("token steward: claim-time scope", () => {
  it("leaves the Secret alone on the pass that claimed the ticket", async () => {
    // A freshly claimed Job is not in the world the renewal step reads, and its
    // token was just minted; renewal cases live in token-renewal.test.ts.
    const { github, k8s } = oneTicket();
    await runReconcilePass({ github, k8s, config }, "webhook");
    expect(k8s.writeLog.filter((w) => w.startsWith("patchSecret"))).toEqual([]);
    expect(k8s.writeLog.filter((w) => w.startsWith("deleteSecret"))).toEqual([]);
  });

  it("does not write expires-at on the PVC (that is the outcome pass, #36)", async () => {
    const { github, k8s } = oneTicket();
    await runReconcilePass({ github, k8s, config }, "webhook");
    expect(k8s.pvcs[0]!.annotations[ANNOTATIONS.expiresAt]).toBeUndefined();
    expect(k8s.writeLog.filter((w) => w.startsWith("patchPvcAnnotations"))).toEqual([]);
  });

  it("never deletes or patches a Job (k8s TTL is the only Job deleter, ADR-0012)", async () => {
    const { github, k8s } = oneTicket();
    await runReconcilePass({ github, k8s, config }, "webhook");
    await runReconcilePass({ github, k8s, config }, "tick");
    expect(k8s.writeLog.filter((w) => w.startsWith("deleteJob"))).toEqual([]);
  });

  it("creates the Ticket PVC once even across repeated passes", async () => {
    const { github, k8s } = oneTicket();
    await runReconcilePass({ github, k8s, config }, "startup");
    await runReconcilePass({ github, k8s, config }, "tick");
    expect(k8s.writeLog.filter((w) => w.startsWith("createPvc"))).toHaveLength(1);
  });
});

describe("claim: labels never leave the gate's authorized set", () => {
  it("adds only agent:in-progress and removes nothing", async () => {
    const { github, k8s } = oneTicket();
    await runReconcilePass({ github, k8s, config }, "webhook");
    const labelWrites = github.writeLog.filter((w) => w.startsWith("editLabels"));
    expect(labelWrites).toEqual([`editLabels ${REPO}#35 +[agent:in-progress] -[]`]);
    expect((await github.getIssue(REPO, 35))?.labels).toEqual([...GATE_LABELS, "agent:in-progress"]);
  });
});
