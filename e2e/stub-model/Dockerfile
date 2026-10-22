# syntax=docker/dockerfile:1
#
# Stub model image for the kind e2e (spec #33 Testing Decisions 3).
#
#   node e2e/build.mjs
#   docker build -f e2e/stub-model/Dockerfile -t remote-agent-e2e/stub-model:local .
#
# No git and no toolchain: this service only speaks the OpenAI streaming wire.

FROM node:22.19-bookworm-slim AS runtime

WORKDIR /app
COPY e2e/dist/stub-model.mjs /app/stub-model.mjs

EXPOSE 8080

ENTRYPOINT ["node", "/app/stub-model.mjs"]
