# syntax=docker/dockerfile:1
# ─── Dependencies ───────────────────────────────────────
# Pinned to .bun-version — reproducible official images.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS dependencies
WORKDIR /app

COPY package.json bun.lock pnpm-workspace.yaml ./
# Preserve workspace paths without making installation depend on source edits.
# Email's postinstall also installs its two nested packages.
COPY --parents apps/*/package.json packages/*/package.json apps/email/*/package.json apps/email/*/bun.lock ./
COPY patches/ ./patches/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ─── Build stage ────────────────────────────────────────
FROM dependencies AS builder
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/dashboard/ ./apps/dashboard/

ENV NEXT_TELEMETRY_DISABLED=1
# Same-origin API proxy (browser → /api/proxy/* → INTERNAL_API_URL). Baked at
# build time (NEXT_PUBLIC_* is inlined) so the dashboard never calls a hardcoded
# API host — works behind any reverse proxy / on a remote host.
ENV NEXT_PUBLIC_API_PROXY=true
RUN cd apps/dashboard && bun run build

# Keep the glibc runtime compatible with native packages selected by Bun.
# ─── Production stage ──────────────────────────────────
FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS runner
WORKDIR /app

COPY --from=builder /app/apps/dashboard/.next/standalone ./
COPY --from=builder /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder /app/apps/dashboard/public ./apps/dashboard/public
# WebSocket-capable entry (server terminal): wraps the standalone server to
# proxy `/api/proxy/*` upgrades to the internal API. See standalone-server.mjs.
COPY --from=builder /app/apps/dashboard/standalone-server.mjs ./apps/dashboard/standalone-server.mjs

ENV NODE_ENV=production
# Next's standalone server otherwise inherits Docker's container-id HOSTNAME,
# which excludes loopback and makes the Compose readiness probe fail.
ENV HOSTNAME=0.0.0.0
EXPOSE 3001
CMD ["node", "apps/dashboard/standalone-server.mjs"]
