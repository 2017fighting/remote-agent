#!/usr/bin/env node
/**
 * Bake the Job image tag into the App image (docs/deployment.md §6).
 *
 * The tag arrives as a Docker build `ARG`, but TypeScript has no compile-time
 * env, so the App Dockerfile runs this script between install and bundle: it
 * rewrites the single `JOB_IMAGE_TAG` line of `app/src/build-info.ts` before
 * esbuild reads it. One source of truth, one value per image.
 *
 *   node scripts/bake-build-info.mjs --tag <job-image-tag> [--file <path>]
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = join(here, "..", "app", "src", "build-info.ts");
const TAG_LINE = /^export const JOB_IMAGE_TAG = ".*";$/m;

function flag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value.trim();
}

function parseTag(argv) {
  const tag = flag(argv, "--tag");
  if (tag === undefined || tag === "") throw new Error("usage: bake-build-info.mjs --tag <job-image-tag> [--file <path>]");
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) {
    throw new Error(`--tag ${JSON.stringify(tag)} is not a valid docker tag`);
  }
  return tag;
}

const argv = process.argv.slice(2);
const tag = parseTag(argv);
const path = resolve(flag(argv, "--file") ?? DEFAULT_FILE);
const source = await readFile(path, "utf8");
if (!TAG_LINE.test(source)) throw new Error(`no JOB_IMAGE_TAG line in ${path}`);
await writeFile(path, source.replace(TAG_LINE, `export const JOB_IMAGE_TAG = ${JSON.stringify(tag)};`), "utf8");
console.log(`baked JOB_IMAGE_TAG=${tag} into ${path}`);
