import { describe, expect, it } from "vitest";
import { ANNOTATIONS, LABELS } from "../src/annotations.js";

describe("annotation and label keys", () => {
  it("pins the three annotation keys", () => {
    expect(ANNOTATIONS.runResult).toBe("remote-agent/run-result");
    expect(ANNOTATIONS.expiresAt).toBe("remote-agent/expires-at");
    expect(ANNOTATIONS.tokenExpiresAt).toBe("remote-agent/token-expires-at");
  });

  it("pins the provenance labels", () => {
    expect(LABELS.managedBy).toBe("app.kubernetes.io/managed-by");
    expect(LABELS.managedByValue).toBe("remote-agent");
    expect(LABELS.ticket).toBe("remote-agent/ticket");
    expect(LABELS.spec).toBe("remote-agent/spec");
    expect(LABELS.repo).toBe("remote-agent/repo");
    expect(LABELS.role).toBe("remote-agent/role");
  });
});
