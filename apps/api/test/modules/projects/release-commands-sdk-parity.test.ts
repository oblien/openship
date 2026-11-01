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

const app = new Hono().onError(handleApiError)
  .route("/api/health", healthRoutes).route("/api/projects", projectRoutes);
async function clients() {
  const owner = await seedOwner();
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: { resolve: async () => ({
      user: { id: user.id, email: user.email, name: user.name }, sessionId: "release-commands-test",
    }) },
  });
  return [
    await ship.scope({ identity: "verified", organizationId: owner.orgId }),
    new OpenshipClient({
      baseUrl: "http://openship.test", token: owner.token, organizationId: owner.orgId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    }),
  ];
}

describe("release command configuration through native SDK and HTTP", () => {
  it("persists commands, freezes them on snapshots, preserves omission and supports explicit clearing", async () => {
    for (const [index, client] of (await clients()).entries()) {
      const project = await client.projects.create({
        name: `Release commands ${index}`, framework: "node", publicEndpoints: [],
        releaseCommands: ["node migrate.js", "node seed.js"],
      });
      expect(project.releaseCommands).toEqual(["node migrate.js", "node seed.js"]);
      const saved = (await repos.project.findById(project.id))!;
      const snapshot = buildConfigSnapshot(saved);
      expect(snapshot.releaseCommands).toEqual(project.releaseCommands);
      await client.projects.setOptions(project.id, { startCommand: "node app.js" });
      expect((await client.projects.get(project.id)).releaseCommands).toEqual(project.releaseCommands);
      await client.projects.setOptions(project.id, { releaseCommands: ["node new-migration.js"] });
      expect((await client.projects.get(project.id)).releaseCommands).toEqual(["node new-migration.js"]);
      expect(snapshot.releaseCommands).toEqual(["node migrate.js", "node seed.js"]);
      await client.projects.setOptions(project.id, { releaseCommands: [] });
      expect((await client.projects.get(project.id)).releaseCommands).toEqual([]);
      expect(buildConfigSnapshot((await repos.project.findById(project.id))!).releaseCommands).toBeUndefined();
      await client.projects.setOptions(project.id, { releaseCommands: null });
      expect((await client.projects.get(project.id)).releaseCommands).toBeNull();
    }
  });

  it("rejects malformed or unbounded command lists before updating the project", async () => {
    for (const [index, client] of (await clients()).entries()) {
      const project = await client.projects.create({ name: `Release validation ${index}`, publicEndpoints: [] });
      for (const value of ["migrate", [42], Array(21).fill("migrate"), ["x".repeat(1001)]]) {
        await expect(client.projects.setOptions(project.id, { releaseCommands: value } as never)).rejects.toThrow();
      }
      expect((await repos.project.findById(project.id))!.releaseCommands).toBeNull();
    }
  });

  it("imports openship.json commands from a local source while honoring explicit opt-outs", async () => {
    const source = await mkdtemp(join(tmpdir(), "openship-release-import-"));
    try {
      await writeFile(join(source, "package.json"), JSON.stringify({ name: "demo", scripts: { start: "node app.js" } }));
      await writeFile(join(source, "openship.json"), JSON.stringify({ releaseCommands: ["node migrate.js"] }));
      for (const [index, client] of (await clients()).entries()) {
        for (const [caseIndex, override] of [undefined, [], null].entries()) {
          const imported = await client.projects.importLocal({
            name: `Local release ${index}-${caseIndex}`, localPath: source, publicEndpoints: [],
            ...(override !== undefined ? { releaseCommands: override } : {}),
          });
          expect(imported.releaseCommands).toEqual(override === undefined ? ["node migrate.js"] : override);
        }
      }
    } finally { await rm(source, { recursive: true, force: true }); }
  });
});
