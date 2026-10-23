import { describe, expect, it, vi } from "vitest";

/**
 * A signal is not a terminal state (ADR-0007 / ADR-0008): the runner must close
 * the harness so the durable storage is left consistent, exit non-zero, and write
 * NO annotation — the next pod resumes from the last checkpoint. Before this, the
 * handler did not exist and `harness.close()` only ran on the normal return path.
 *
 * The behaviour is asserted structurally: the source installs SIGTERM/SIGINT
 * handlers around the run, and the signal path never reaches `annotate`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SOURCE = join(import.meta.dirname, "..", "src", "internal", "runner.ts");

describe("runner signal handling", () => {
  it("installs SIGTERM and SIGINT handlers", async () => {
    const source = await readFile(SOURCE, "utf8");
    expect(source).toMatch(/["']SIGTERM["']/);
    expect(source).toMatch(/["']SIGINT["']/);
  });

  it("closes the harness and exits non-zero on a signal, without annotating", async () => {
    const source = await readFile(SOURCE, "utf8");
    // Find the signal handler body and assert the three contract points.
    const start = source.indexOf("const onSignal");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("const signals", start));
    expect(body).toMatch(/harness\.close\(/);
    expect(body).toMatch(/process\.exit\(1\)/);
    expect(body).not.toMatch(/annotate\(/);
  });

  it("detaches the handlers on the normal path, so a clean exit cannot be re-entered", async () => {
    const source = await readFile(SOURCE, "utf8");
    expect(source).toMatch(/removeListener\(signal, handler\)/);
  });
});
