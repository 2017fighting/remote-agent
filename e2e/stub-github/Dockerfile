# syntax=docker/dockerfile:1
#
# Stub GitHub image for the kind e2e (spec #33 Testing Decisions 3).
#
#   node e2e/build.mjs
#   docker build -f e2e/stub-github/Dockerfile -t remote-agent-e2e/stub-github:local .
#
# The bundle is built on the host by `e2e/build.mjs` (the same esbuild shape the
# App and Job images use), so this file only assembles a runtime image. `git` is
# the one real dependency: the stub serves clone/ls-remote/push through
# `git http-backend`, so the binary must be the real thing.

FROM node:22.19-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY e2e/dist/stub-github.mjs /app/stub-github.mjs

EXPOSE 8080

ENTRYPOINT ["node", "/app/stub-github.mjs"]
