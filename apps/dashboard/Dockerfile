# ─── Build stage ────────────────────────────────────────
FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml* package.json ./
COPY tooling/ ./tooling/
COPY packages/ ./packages/
COPY apps/dashboard/ ./apps/dashboard/

RUN pnpm install --frozen-lockfile
RUN pnpm run build --filter=openship-dashboard...

# ─── Production stage ──────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

COPY --from=builder /app/apps/dashboard/.next/standalone ./
COPY --from=builder /app/apps/dashboard/.next/static ./.next/static
COPY --from=builder /app/apps/dashboard/public ./public

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server.js"]
