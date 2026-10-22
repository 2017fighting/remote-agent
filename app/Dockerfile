# syntax=docker/dockerfile:1
#
# App image (docs/deployment.md §6): the webhook + reconcile service.
#
#   docker build -f app/Dockerfile --build-arg JOB_IMAGE_TAG=<tag> -t ghcr.io/2017fighting/remote-agent:<tag> .
#
# `JOB_IMAGE_TAG` is baked into the image as a compile constant (app/src/build-info.ts):
# the App image and the Job image are released together by one workflow, so the Job
# tag must not be something an operator can point elsewhere at deploy time.

# --- build --------------------------------------------------------------------
FROM node:22.19-bookworm-slim AS build
WORKDIR /build

COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY app/package.json app/
COPY job/package.json job/
RUN npm ci --ignore-scripts

COPY shared shared
COPY app app
COPY scripts scripts

# ARG → compiled constant: rewrite build-info.ts before bundling, so the value the
# App reads at runtime is the tag CI actually pushed for the Job image.
ARG JOB_IMAGE_TAG=0.0.0-dev
RUN node scripts/bake-build-info.mjs --tag "${JOB_IMAGE_TAG}" \
 && node_modules/.bin/esbuild app/src/main.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --outfile=dist/main.mjs

# --- runtime ------------------------------------------------------------------
FROM node:22.19-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The base image's `node` user is already uid/gid 1000 — the same uid the Job pods use.

ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    PORT=8080

WORKDIR /app
COPY --from=build /build/dist/main.mjs /app/main.mjs
# `main.mjs` exports startApp(); this glue is what actually starts it and wires
# SIGTERM to a clean stop (ADR-0008: close before the pod goes away).
COPY --from=build /build/scripts/app-entry.mjs /app/app-entry.mjs
RUN chown -R 1000:1000 /app

USER 1000
EXPOSE 8080

ENTRYPOINT ["node"]
CMD ["/app/app-entry.mjs"]
