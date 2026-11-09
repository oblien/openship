# syntax=docker/dockerfile:1
# ─── Dependencies ───────────────────────────────────────
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
COPY apps/web/ ./apps/web/

ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && bun run build

# Keep the glibc runtime compatible with native packages selected by Bun.
# ─── Production stage ──────────────────────────────────
FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS runner
WORKDIR /app

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
