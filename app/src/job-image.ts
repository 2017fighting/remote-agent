/**
 * Job image tag used by the Job template (docs/deployment.md §6): the tag is
 * baked into the App image at build time (`Dockerfile ARG` → compile constant),
 * so home-ops pins one tag in one place.
 *
 * TODO(#39): replace this placeholder with the build-time baked constant once
 * the CI build (`Dockerfile ARG` → generated module) lands. Do not read it from
 * env: the App image and the Job image are released together, and a tag that
 * can drift between them is a silent "runs yesterday's runner" failure.
 */
export const JOB_IMAGE_REPOSITORY = "ghcr.io/2017fighting/remote-agent-job";

/** Placeholder tag until #39 bakes the real one. */
export const JOB_IMAGE_TAG = "latest";

export const JOB_IMAGE = `${JOB_IMAGE_REPOSITORY}:${JOB_IMAGE_TAG}`;
