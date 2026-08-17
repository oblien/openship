FROM oven/bun:1.3-alpine
WORKDIR /opt/openship
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY packages/core/src/agent-protocol.ts packages/core/src/agent-protocol.ts
COPY apps/agent apps/agent
RUN bun install --filter @repo/agent --filter @repo/core
WORKDIR /opt/openship/apps/agent
ENV NODE_ENV=production
EXPOSE 7422
CMD ["bun", "src/main.ts"]
