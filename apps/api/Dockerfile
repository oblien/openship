# syntax=docker/dockerfile:1
# ─── Build stage ────────────────────────────────────────
# Pin bun (was :latest — non-deterministic; drifted to 1.3.14) to .bun-version.
FROM oven/bun:1.3.3 AS builder
WORKDIR /app

COPY package.json bun.lock pnpm-workspace.yaml ./
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/

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
FROM oven/bun:1.3.3 AS runner
WORKDIR /app

# Remote-server management from the containerized control plane:
#   • openssh-client — SSH-agent auth + git-credential reverse-forwarding shell
#     out to the OS `ssh` binary (default password/key SSH is pure-JS ssh2 and
#     needs neither, but those paths do; also the SSH-to-host executor).
#   • rsync — release staging on bare deploy targets.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client rsync \
 && rm -rf /var/lib/apt/lists/*

# @repo/* are TypeScript-SOURCE workspace packages (package.json main =
# src/index.ts) resolved via the ROOT package.json "workspaces" field — there
# is NO node_modules/@repo; bun points straight at packages/*. tsup externalizes
# them (dist does `import { repos } from "@repo/db"`), so the runner MUST ship
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

ENV NODE_ENV=production
EXPOSE 4000
CMD ["bun", "run", "apps/api/dist/index.js"]
