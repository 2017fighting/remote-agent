#!/usr/bin/env node
/**
 * Bundle the two e2e stub services (spec #33 Testing Decisions 3).
 *
 * The stubs run inside kind as real Deployments, and — like the App and Job
 * images (app/Dockerfile, job/Dockerfile) — they ship as single-file esbuild
 * bundles rather than a node_modules tree. Bundling here means `make e2e` and CI
 * build the stubs exactly the way the images do, so a stub that runs locally is
 * the stub that runs in the cluster.
 *
 *   node e2e/build.mjs [--outdir <dir>]
 */
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

const ENTRIES = [
  { entry: "stub-github/server.ts", outfile: "stub-github.mjs" },
  { entry: "stub-model/server.ts", outfile: "stub-model.mjs" },
];

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

const outdir = resolve(flag(process.argv.slice(2), "--outdir") ?? join(here, "dist"));
await mkdir(outdir, { recursive: true });

for (const { entry, outfile } of ENTRIES) {
  await build({
    entryPoints: [join(here, entry)],
    outfile: join(outdir, outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Node built-ins stay external; everything else is inlined.
    packages: "bundle",
    logLevel: "warning",
  });
  console.log(`bundled ${entry} -> ${join(outdir, outfile)}`);
}
