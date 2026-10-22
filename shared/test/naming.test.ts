import { describe, expect, it } from "vitest";
import { K8S_NAME_MAX_LENGTH, jobName, pvcName, repoSlug, secretName } from "../src/naming.js";

describe("deterministic naming", () => {
  it("lowercases owner-repo and maps non [a-z0-9-] chars to -", () => {
    expect(repoSlug("2017fighting/remote-agent")).toBe("2017fighting-remote-agent");
    expect(repoSlug("Foo.Bar_Baz/Qux")).toBe("foo-bar-baz-qux");
  });

  it("builds the Job name with role never in it", () => {
    expect(jobName("2017fighting/remote-agent", 34)).toBe("agent-2017fighting-remote-agent-34");
  });

  it("Ticket PVC shares the Job name; Secret adds the -token suffix", () => {
    const ownerRepo = "2017fighting/remote-agent";
    expect(pvcName(ownerRepo, 34)).toBe(jobName(ownerRepo, 34));
    expect(secretName(ownerRepo, 34)).toBe(`${jobName(ownerRepo, 34)}-token`);
  });

  it("truncates the slug so every name fits 63 chars with the suffix budget", () => {
    const long = "A".repeat(80);
    const n = 123456;
    // The Secret is the longest name; at max truncation it is exactly 63.
    expect(secretName(long, n).length).toBe(K8S_NAME_MAX_LENGTH);
    expect(secretName(long, n).endsWith("-token")).toBe(true);
    expect(jobName(long, n).length).toBeLessThanOrEqual(K8S_NAME_MAX_LENGTH);
    expect(jobName(long, n).startsWith("agent-")).toBe(true);
    expect(jobName(long, n).endsWith(`-${n}`)).toBe(true);
    expect(pvcName(long, n).length).toBeLessThanOrEqual(K8S_NAME_MAX_LENGTH);
  });

  it("keeps names stable at the 63-char boundary", () => {
    const ownerRepo = "2017fighting/remote-agent-2017fighting"; // slug 37 chars
    const name = jobName(ownerRepo, 9);
    expect(name).toBe("agent-2017fighting-remote-agent-2017fighting-9");
    expect(name.length).toBeLessThanOrEqual(K8S_NAME_MAX_LENGTH);
  });
});
