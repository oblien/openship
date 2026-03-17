# ─── Build stage ────────────────────────────────────────
FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json bun.lock pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/

RUN bun install --frozen-lockfile
RUN cd apps/api && bun run build

# ─── Production stage ──────────────────────────────────
FROM oven/bun:1-slim AS runner
WORKDIR /app

COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/package.json ./
COPY --from=builder /app/node_modules ./node_modules

ENV NODE_ENV=production
EXPOSE 4000
CMD ["bun", "run", "dist/index.js"]
