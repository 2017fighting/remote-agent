#!/usr/bin/env node
/**
 * `make e2e` / `npm run e2e` entrypoint for the kind e2e (ticket #41).
 *
 * The harness is TypeScript; this glue bundles it with esbuild (the same shape
 * the images use) and runs it, so the command works from a clean checkout
 * without a TS loader. Pass `--keep` to leave the scratch directory behind,
 * `--verbose` to echo every command's output, `--no-cleanup` to leave the kind
 * cluster running, and `--timeout <seconds>` to change the per-assertion bound.
 *
 *   node e2e/run.mjs
 *   node e2e/run.mjs --verbose --keep --timeout 600
 */
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "remote-agent-e2e-bundle-"));

// The bundled harness builds images from the checkout, so tell it where that is
// (its own `import.meta.url` points into this temp directory, not the repo).
process.env["RA_E2E_REPO_ROOT"] = resolve(here, "..");

try {
  const outfile = join(scratch, "run.mjs");
  await build({
    entryPoints: [join(here, "src", "run.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    packages: "bundle",
    logLevel: "warning",
  });
  const module = await import(pathToFileURL(outfile).href);
  await module.main();
} finally {
  await rm(scratch, { recursive: true, force: true });
}
