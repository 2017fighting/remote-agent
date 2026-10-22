import { describe, expect, it } from "vitest";
import { ANNOTATIONS, LABELS } from "../src/annotations.js";

describe("annotation and label keys", () => {
  it("pins the five annotation keys", () => {
    expect(ANNOTATIONS.runResult).toBe("remote-agent/run-result");
    expect(ANNOTATIONS.expiresAt).toBe("remote-agent/expires-at");
    expect(ANNOTATIONS.tokenExpiresAt).toBe("remote-agent/token-expires-at");
    expect(ANNOTATIONS.repo).toBe("remote-agent/repo");
    expect(ANNOTATIONS.ticket).toBe("remote-agent/ticket");
  });

  it("pins the provenance labels", () => {
    expect(LABELS.managedBy).toBe("app.kubernetes.io/managed-by");
    expect(LABELS.managedByValue).toBe("remote-agent");
    expect(LABELS.spec).toBe("remote-agent/spec");
    expect(LABELS.role).toBe("remote-agent/role");
  });

  it("keeps identity out of the labels, where `owner/name` and `#n` cannot live", () => {
    // A label value may only be [A-Za-z0-9] with -_. inside; `/` and `#` are
    // rejected by the API server with 422, so the repo/ticket triple can only
    // be an annotation (ADR-0011).
    const labelValues = Object.values(LABELS);
    expect(labelValues).not.toContain("remote-agent/ticket");
    expect(labelValues).not.toContain("remote-agent/repo");
    expect(ANNOTATIONS.repo).toBe("remote-agent/repo");
    expect(ANNOTATIONS.ticket).toBe("remote-agent/ticket");
  });
});
