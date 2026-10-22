# syntax=docker/dockerfile:1
#
# Job image (ADR-0005): the init container's `seed` and the main container's
# `runner`, plus the tools the agent shells out to. Built from this repo only —
# no base image from another project, because the entrypoint contract here is
# remote-agent's own (Job env, Ticket PVC layout, Result tools).
#
#   docker build -f job/Dockerfile -t ghcr.io/2017fighting/remote-agent-job:<tag> .
#
# The image carries no prompt (ADR-0004): prompts come from the mounted ConfigMap.

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
RUN node_modules/.bin/esbuild job/src/seed.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --outfile=dist/seed.mjs \
 && node_modules/.bin/esbuild job/src/runner.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --outfile=dist/runner.mjs

# --- runtime ------------------------------------------------------------------
FROM node:22.19-bookworm-slim AS runtime

# git is the seed's and the agent's main tool; ca-certificates and ripgrep are
# what every target repo's toolchain assumes is present.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*

# Non-root, uid 1000: the Job's pod runs with fsGroup 1000, and git must not see
# root-owned files in the Ticket PVC worktree (ADR-0009).
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin agent

# ADR-0010: HOME lives on the Ticket PVC so npm does not refetch on every pod.
ENV HOME=/mnt/agent/home \
    NODE_ENV=production \
    NODE_NO_WARNINGS=1

WORKDIR /mnt/agent/repo

COPY --from=build /build/dist/seed.mjs /opt/remote-agent/seed.mjs
COPY --from=build /build/dist/runner.mjs /opt/remote-agent/runner.mjs

USER 1000

# Both containers share this image: the Job template overrides the command.
ENTRYPOINT ["node"]
CMD ["/opt/remote-agent/runner.mjs"]
