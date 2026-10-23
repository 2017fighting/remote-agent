/**
 * Job package entry points.
 *
 * The two executables are `seed.ts` (init container) and `runner.ts` (main
 * container); `job/Dockerfile` bundles both and pins the init container's
 * `command` to the seed entrypoint. They share the internal library under
 * `src/internal/` and read the contract from `@remote-agent/shared` — they never
 * guess its values.
 */
export { runSeed } from "./seed.js";
export { runRunner } from "./runner.js";
