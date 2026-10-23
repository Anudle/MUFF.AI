# syntax=docker/dockerfile:1
#
# MUFF-64 — the MCP server as a Lambda container image.
#
# Two stages. Both run at `docker build` time; only the second becomes the
# image that ships. The build stage has the toolchain (npm, esbuild, dev
# deps, TypeScript sources). The runtime stage has Node, the Lambda Runtime
# Interface Client, and the bundles — nothing else. No node_modules in the
# final image because esbuild inlines every dependency into one file, the
# same artifact infra/deploy.sh has zipped since MUFF-39.
#
# Base images are pinned by digest (the tag is for humans; the digest is the
# pin). Refresh with:
#   docker buildx imagetools inspect node:22-slim
#   docker buildx imagetools inspect public.ecr.aws/lambda/nodejs:22
#
# Build / run locally (Runtime Interface Emulator is baked into the base):
#   docker build --provenance=false -t muff-mcp .
#   docker run --rm -p 9009:8080 -e MCP_AUTH_TOKEN=dev muff-mcp
#   curl -s localhost:9009/2015-03-31/functions/function/invocations -d @infra/rie-event.json
# The whole local stack (same image + S3 stand-in) is `docker compose up`.

# ---- build stage ------------------------------------------------------------
FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build

# Build as the unprivileged `node` user the image ships with. (The runtime
# stage below has no USER line on purpose: Lambda already runs the handler as
# an unprivileged sandbox user, and the base image's entrypoint expects root
# to hand off to it.)
RUN mkdir -p /home/node/app && chown node:node /home/node/app
USER node
WORKDIR /home/node/app

# Lockfile first so the dependency layer is cached when only source changes.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci

COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts/mcp-http-local.ts ./scripts/

# Two bundles from one source tree:
#   index.mjs      — the Lambda handler (CMD below); what prod runs.
#   local-http.mjs — a plain HTTP front for the same handler code, used by
#                    compose.yaml and CI so an MCP client can talk to the
#                    container without wrapping requests in Lambda events.
# `.mjs` is what tells Node the bundle is an ES module; no package.json needed.
RUN npx esbuild src/mcp/lambda.ts --bundle --platform=node --format=esm --target=node22 \
      --outfile=dist/index.mjs --log-level=warning \
      --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
 && npx esbuild scripts/mcp-http-local.ts --bundle --platform=node --format=esm --target=node22 \
      --outfile=dist/local-http.mjs --log-level=warning \
      --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'

# ---- runtime stage ----------------------------------------------------------
# Provides: Node 22, the Runtime Interface Client (polls Lambda's runtime API
# and calls the handler), an ENTRYPOINT that runs the RIC in Lambda and the
# emulator locally, and LAMBDA_TASK_ROOT=/var/task where code must live.
FROM public.ecr.aws/lambda/nodejs:22@sha256:d138eff445f6ea04c51091d8e6cbb064d5663e850cddfa62396061586f98b126

COPY --from=build /home/node/app/dist/index.mjs /home/node/app/dist/local-http.mjs ${LAMBDA_TASK_ROOT}/

# Runtime config (MCP_AUTH_TOKEN, TOKENS_SECRET_ID, Yahoo creds, provider
# vars) is injected by Lambda / compose at run time — never baked in here.

# `file.export`: the RIC loads /var/task/index.mjs and calls `handler`.
CMD ["index.handler"]
