import { describe, expect, it } from "vitest";
import { assertMetadataValid } from "../src/fakes/k8s-metadata.js";
import { renderJobManifest, renderTicketPvc } from "../src/renders/job-template.js";
import { renderTokenSecret } from "../src/renders/token-steward.js";
import { jobName } from "@remote-agent/shared";
import { testConfig } from "./helpers.js";

/**
 * Every object the App builds must pass the API server's metadata validation.
 *
 * This is the render-layer guarantee behind the kind e2e: the App once wrote
 * `remote-agent/ticket: owner/name#34`, a value k8s rejects with 422, and the
 * whole suite stayed green because `FakeK8s` did not validate. The fake now
 * rejects it too, and this test pins the same rule on the rendered objects —
 * both roles, the Ticket PVC and the per-Job Secret — so the class cannot come
 * back through a render change that never reaches the fake.
 */

const REPO = "2017fighting/remote-agent";
const config = testConfig();

function assertValid(rendered: {
  name: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}): void {
  expect(() =>
    assertMetadataValid({
      kind: "Object",
      name: rendered.name,
      labels: rendered.labels,
      annotations: rendered.annotations,
    }),
  ).not.toThrow();
}

describe("rendered metadata is legal for the API server", () => {
  for (const role of ["implement-ticket", "implement-spec"] as const) {
    it(`the ${role} Job`, () => {
      const job = renderJobManifest({
        config,
        targetRepo: REPO,
        issueNumber: 35,
        specNumber: 33,
        role,
        workItemJson: "{}",
      });
      assertValid(job);
      // The identity is carried exactly, not slugified: token renewal and slot
      // accounting need `owner/name` back (ADR-0011).
      expect(job.annotations["remote-agent/repo"]).toBe(REPO);
      expect(job.annotations["remote-agent/ticket"]).toBe(`${REPO}#35`);
    });

    it(`the ${role} Ticket PVC`, () => {
      const pvc = renderTicketPvc({ config, targetRepo: REPO, issueNumber: 35, specNumber: 33 });
      assertValid(pvc);
      expect(pvc.annotations["remote-agent/ticket"]).toBe(`${REPO}#35`);
    });
  }

  it("the per-Job token Secret", () => {
    const secret = renderTokenSecret({
      namespace: config.namespace,
      targetRepo: REPO,
      issueNumber: 35,
      specNumber: 33,
      minted: { token: "ghs_x", expiresAt: "2026-01-01T00:00:00Z" },
    });
    assertValid(secret);
    expect(secret.name).toBe(`${jobName(REPO, 35)}-token`);
  });
});
