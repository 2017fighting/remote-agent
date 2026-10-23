import { describe, expect, it } from "vitest";
import { VOLUME_PATHS, jobName, secretName, pvcName } from "@remote-agent/shared";
import { runRunner, runSeed } from "../src/index.js";

/** The job package resolves the shared contract module and exposes its entries. */
describe("job workspace wiring", () => {
  it("resolves the shared contract module", () => {
    expect(VOLUME_PATHS.mountRoot).toBe("/mnt/agent");
    const n = jobName("2017fighting/remote-agent", 34);
    expect(secretName("2017fighting/remote-agent", 34)).toBe(`${n}-token`);
    expect(pvcName("2017fighting/remote-agent", 34)).toBe(n);
  });

  it("exports both executables, since the image bundles and runs them", () => {
    // The init container's `command` and the image's `CMD` name these entries, so
    // the package must actually export them.
    expect(typeof runSeed).toBe("function");
    expect(typeof runRunner).toBe("function");
  });
});
