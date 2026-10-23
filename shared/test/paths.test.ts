import { describe, expect, it } from "vitest";
import { commentMarker, specBranch, VOLUME_PATHS } from "../src/paths.js";

describe("path constants", () => {
  it("pins the Ticket PVC volume layout", () => {
    expect(VOLUME_PATHS.mountRoot).toBe("/mnt/agent");
    expect(VOLUME_PATHS.repo).toBe("/mnt/agent/repo");
    expect(VOLUME_PATHS.state).toBe("/mnt/agent/state");
    expect(VOLUME_PATHS.home).toBe("/mnt/agent/home");
    expect(VOLUME_PATHS.seedMarker).toBe("/mnt/agent/state/seeded.json");
    expect(VOLUME_PATHS.seedError).toBe("/mnt/agent/state/seed-error.json");
  });

  it("builds the comment marker `<!-- remote-agent:<kind>:<job-name> -->`", () => {
    expect(commentMarker("done", "agent-owner-repo-12")).toBe(
      "<!-- remote-agent:done:agent-owner-repo-12 -->",
    );
    expect(commentMarker("blocked", "j")).toBe("<!-- remote-agent:blocked:j -->");
  });

  it("builds the spec closeout branch agent/spec-<n>", () => {
    expect(specBranch(33)).toBe("agent/spec-33");
  });
});
