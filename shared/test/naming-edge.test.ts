import { describe, expect, it } from "vitest";
import { K8S_NAME_MAX_LENGTH, jobName, repoSlug, secretName } from "../src/naming.js";

describe("repo-slug and 63-char truncation edge cases", () => {
  it("collapses nothing — only char mapping and truncation, exactly as specified", () => {
    expect(repoSlug("A.B/C_D")).toBe("a-b-c-d");
    expect(repoSlug("already-slug")).toBe("already-slug");
    expect(repoSlug("2017fighting/pi-web")).toBe("2017fighting-pi-web");
  });

  it("names fit 63 chars for a range of issue number widths", () => {
    for (const n of [1, 9, 99, 999, 9999, 99999, 999999, 9999999]) {
      const ownerRepo = "x".repeat(200);
      expect(jobName(ownerRepo, n).length).toBeLessThanOrEqual(K8S_NAME_MAX_LENGTH);
      expect(secretName(ownerRepo, n).length).toBeLessThanOrEqual(K8S_NAME_MAX_LENGTH);
      expect(jobName(ownerRepo, n).endsWith(`-${n}`)).toBe(true);
      expect(secretName(ownerRepo, n).endsWith(`-${n}-token`)).toBe(true);
    }
  });

  it("does not truncate ordinary names", () => {
    expect(jobName("2017fighting/remote-agent", 34)).toBe("agent-2017fighting-remote-agent-34");
  });
});
