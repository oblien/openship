# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS node-build
FROM --platform=$BUILDPLATFORM golang:1.26.9-bookworm AS actions-runner
WORKDIR /runner
COPY packages/actions-runner/go.mod packages/actions-runner/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY packages/actions-runner/ ./
COPY --from=node-build /usr/local/bin/node /usr/local/bin/node
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    node build.mjs

# ─── Build stage ────────────────────────────────────────
# Keep the dependency installer on .bun-version.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder
WORKDIR /app

COPY package.json bun.lock pnpm-workspace.yaml ./
COPY tsconfig.base.json ./
COPY patches/ ./patches/
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY --from=actions-runner /runner/dist ./packages/actions-runner/dist

# The build died in "Resolving dependencies" — bun's network metadata resolution
# for the whole monorepo, slow enough to trip the build's idle timeout.
# --frozen-lockfile skips resolution entirely (installs straight from bun.lock),
# and the BuildKit cache mount reuses bun's download store across builds so a
# rebuild doesn't re-fetch the graph. (Cache mount needs BuildKit — Compose v2
# enables it by default.)
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile \
 && cd apps/api && bun run build

# ─── Production stage ──────────────────────────────────
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

# Remote-server management from the containerized control plane:
#   • openssh-client — SSH-agent auth + git-credential reverse-forwarding shell
#     out to the OS `ssh` binary (default password/key SSH is pure-JS ssh2 and
#     needs neither, but those paths do; also the SSH-to-host executor).
#   • rsync — release staging on bare deploy targets.
#   • git — the API-HOST CLONE. Every deploy that can't clone on the server falls
#     back to cloning here and transferring the build context, and that fallback
#     shells out to `git`. Without it the fallback died with
#     `Executable not found in $PATH: "git"` AFTER announcing it was falling back
#     — so a containerized install could not deploy a private repo at all unless
#     the server had its own credential. It is a build dependency of the control
#     plane, not an optional extra.
#   • ca-certificates provides the OS trust store used by git and SSH helpers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client rsync git ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/*

# @repo/* exports TypeScript source through workspace links under packages/.
# tsup leaves those imports external, so the runner must ship
# the whole workspace, not just apps/api/dist:
#   • root manifests (the "workspaces" field is what resolves @repo/*)
#   • packages/ — incl. packages/db/drizzle, which the DB client auto-migrates
#     from on boot (MIGRATIONS_DIR = resolve(packages/db/src, "../drizzle"))
#   • node_modules (bun-installed on this same linux base)
#   • the compiled apps/api/dist (+ apps/api/package.json)
# Copying only apps/api/dist + node_modules (the previous version) made
# @repo/db unresolvable and the API crashed on startup.
COPY --from=builder /app/package.json /app/bun.lock /app/pnpm-workspace.yaml /app/tsconfig.base.json ./
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api ./apps/api
# The iRedMail engine is DATA, not code: mail setup step 7 tars this tree and
# stages it onto the target box (see resolveLocalEngineDir). Without it the
# containerized API fails the step with "tar: apps/email/engine: Cannot open".
COPY --from=builder /app/apps/email/engine ./apps/email/engine

ENV NODE_ENV=production
EXPOSE 4000
# tsx loads the TypeScript workspace packages that tsup leaves external.
CMD ["node", "--import", "tsx", "apps/api/dist/index.js"]
