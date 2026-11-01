import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { repos } from "@repo/db";
import { seedOwner } from "../jobs/_harness";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { buildConfigSnapshot } from "@repo/platform/engine/modules/deployments/build.service";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/projects", projectRoutes);
async function clients() {
  const owner = await seedOwner();
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "dockerfile-import-test",
      }),
    },
  });
  return [
    await ship.scope({ identity: "verified", organizationId: owner.orgId }),
    new OpenshipClient({
      baseUrl: "http://openship.test",
      token: owner.token,
      organizationId: owner.orgId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    }),
  ];
}

describe("Dockerfile command defaults through native SDK and HTTP", () => {
  it("persists image defaults as a web workload and preserves explicit command overrides", async () => {
    const source = await mkdtemp(join(tmpdir(), "openship-docker-import-"));
    try {
      await writeFile(
        join(source, "package.json"),
        JSON.stringify({
          scripts: { start: "node server.js --port 3000", build: "next build" },
          dependencies: { next: "^16" },
        }),
      );
      await writeFile(join(source, "next.config.js"), "module.exports = {};");
      await writeFile(join(source, "bun.lock"), "{}");
      await writeFile(
        join(source, "Dockerfile"),
        'FROM node:22-alpine\nEXPOSE 8080\nCMD ["node", "server.js"]',
      );
      for (const [index, client] of (await clients()).entries()) {
        for (const [caseIndex, startCommand] of [
          undefined,
          "node worker.js",
        ].entries()) {
          const imported = await client.projects.importLocal({
            name: `Docker import ${index}-${caseIndex}`,
            localPath: source,
            publicEndpoints: [],
            ...(startCommand !== undefined ? { startCommand } : {}),
          });
          const saved = (await repos.project.findById(imported.id))!;
          expect(saved).toMatchObject({
            framework: "docker",
            startCommand: startCommand ?? "",
            hasServer: true,
            port: 8080,
          });
          expect(buildConfigSnapshot(saved)).toMatchObject({
            framework: "docker",
            startCommand: startCommand ?? "",
            hasServer: true,
            port: 8080,
          });
        }
      }
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });
});
