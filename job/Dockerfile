# syntax=docker/dockerfile:1
#
# Job image (ADR-0005): the init container's `seed` and the main container's
# `runner`, plus the tools the agent shells out to. Built from this repo only —
# no base image from another project, because the entrypoint contract here is
# remote-agent's own (Job env, Ticket PVC layout, Result tools).
#
#   docker build -f job/Dockerfile -t ghcr.io/2017fighting/remote-agent-job:<tag> .
#
# The image carries the prompt templates (ADR-0020): `prompts/` is copied to
# IMAGE_PROMPTS_DIR and the runner reads them from there. An operator can still
# override a single key through `PROMPTS_DIR`; that hatch is wired by a later
# ticket of #75.

# --- build: compile the two entrypoints into self-contained bundles -------------
FROM node:22.19-bookworm-slim AS build
WORKDIR /build

# Manifests first so dependency layers cache independently of source edits.
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY job/package.json job/
COPY app/package.json app/
RUN npm ci --ignore-scripts

COPY shared shared
COPY job job
COPY scripts scripts

# One bundle per entrypoint: the Job image must not need the workspace at runtime.
#
# `--banner:js` gives the ESM bundle a real `require`: pi-ai pulls CommonJS
# dependencies that call `require("node:…")` at load time, which esbuild's ESM
# output cannot resolve on its own.
RUN node_modules/.bin/esbuild job/src/seed.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --banner:js='import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' \
      --outfile=dist/seed.mjs \
 && node_modules/.bin/esbuild job/src/runner.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --banner:js='import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' \
      --outfile=dist/runner.mjs

# --- runtime ------------------------------------------------------------------
FROM node:22.19-bookworm-slim AS runtime

# git is the seed's and the agent's main tool; ca-certificates and ripgrep are
# what every target repo's toolchain assumes is present.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*

# The base image's `node` user is already uid/gid 1000, which is what the Job's
# pod fsGroup uses (ADR-0009): git must not see root-owned files in the Ticket PVC.

# ADR-0010: HOME lives on the Ticket PVC so npm does not refetch on every pod.
ENV HOME=/mnt/agent/home \
    NODE_ENV=production \
    NODE_NO_WARNINGS=1

WORKDIR /mnt/agent/repo

COPY --from=build /build/dist/seed.mjs /opt/remote-agent/seed.mjs
COPY --from=build /build/dist/runner.mjs /opt/remote-agent/runner.mjs
# The prompt key surface travels with the image (ADR-0020). The target path is
# IMAGE_PROMPTS_DIR in shared/src/paths.ts; a unit test asserts this COPY stays.
COPY prompts /opt/remote-agent/prompts
RUN chown -R 1000:1000 /opt/remote-agent

USER 1000

# Both containers share this image: the Job template overrides the command.
ENTRYPOINT ["node"]
CMD ["/opt/remote-agent/runner.mjs"]
