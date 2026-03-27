# ─── Build stage ────────────────────────────────────────
FROM oven/bun:1.3.10 AS builder
WORKDIR /app

COPY package.json bun.lock pnpm-workspace.yaml ./
COPY packages/ ./packages/
COPY apps/ ./apps/

RUN bun install
RUN cd apps/dashboard && bun run build

# ─── Production stage ──────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

COPY --from=builder /app/apps/dashboard/.next/standalone ./
COPY --from=builder /app/apps/dashboard/.next/static ./.next/static
COPY --from=builder /app/apps/dashboard/public ./public

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server.js"]
