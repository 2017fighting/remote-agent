import { describe, expect, it } from "vitest";
import { JOB_ENTRY } from "../src/index.js";
import { VOLUME_PATHS, jobName, secretName, pvcName } from "@remote-agent/shared";

/** #34 only wires the job workspace; it must resolve the shared contract module. */
describe("job workspace wiring", () => {
  it("resolves the shared contract module", () => {
    expect(VOLUME_PATHS.mountRoot).toBe("/mnt/agent");
    const n = jobName("2017fighting/remote-agent", 34);
    expect(secretName("2017fighting/remote-agent", 34)).toBe(`${n}-token`);
    expect(pvcName("2017fighting/remote-agent", 34)).toBe(n);
  });

  it("marks the entry as not implemented in this ticket", () => {
    expect(JOB_ENTRY).toMatch(/not-implemented/);
  });
});
