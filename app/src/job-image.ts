/**
 * Job image reference for the Job template (docs/deployment.md §6). #35 shipped
 * this file as a placeholder with `TODO(#39): replace this placeholder with the
 * build-time baked constant`; that replacement is now a re-export, so the value
 * lives in exactly one place — `build-info.ts`, which the App image build
 * rewrites from the `JOB_IMAGE_TAG` build arg.
 *
 * Never read the tag from env: the App image and the Job image are released
 * together, and a tag that can drift between them is a silent "runs yesterday's
 * runner" failure.
 */
export { JOB_IMAGE, JOB_IMAGE_REPOSITORY, JOB_IMAGE_TAG } from "./build-info.js";
