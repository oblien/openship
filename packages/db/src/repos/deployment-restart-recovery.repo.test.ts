import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createEncryption } from "../encryption";
import { createDeploymentRepo } from "./deployment.repo";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

describe("self-hosted deployment restart recovery", () => {
  it("unblocks orphaned workers without changing completed releases or losing their logs (#919)", async () => {
    const client = new PGlite("memory://");
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      await client.exec("SET session_replication_role = replica;");
      const repo = createDeploymentRepo(db, createEncryption("repository-test-secret"));
      const statuses = [
        "queued",
        "building",
        "deploying",
        "cancelled",
        "failed",
        "ready",
        "reconciling",
      ];
      const logs = [{ message: "The original deployment output", level: "info" }];
      for (const status of statuses) {
        await db.insert(schema.project).values({
          id: `project-${status}`,
          organizationId: "org1",
          groupId: `group-${status}`,
          name: status,
          slug: status,
        });
        await db.insert(schema.deployment).values({
          id: `dep-${status}`,
          projectId: `project-${status}`,
          organizationId: "org1",
          status,
          branch: "main",
          errorMessage: "Original result",
        });
        await db.insert(schema.buildSession).values({
          id: `session-${status}`,
          deploymentId: `dep-${status}`,
          projectId: `project-${status}`,
          status,
          startedAt: status === "queued" ? null : new Date(0),
          logs,
          durationMs: 1234,
        });
      }

      const replacement = {
        projectId: "project-cancelled",
        organizationId: "org1",
        status: "queued",
        branch: "main",
      };
      expect(await repo.create(replacement)).toBeUndefined();
      expect(await repo.hasLiveBuildExecution("dep-cancelled", "project-cancelled")).toBe(true);
      expect(await repo.sweepStaleInFlight("Server restarted")).toBe(3);

      for (const status of statuses) {
        const interrupted = ["queued", "building", "deploying"].includes(status);
        expect(await repo.findById(`dep-${status}`)).toMatchObject({
          status: interrupted ? "cancelled" : status,
          errorMessage: interrupted ? "Server restarted" : "Original result",
        });
        expect(await repo.findBuildSessionByDeploymentId(`dep-${status}`)).toMatchObject({
          status: interrupted ? "cancelled" : status,
          finishedAt: expect.any(Date),
          logs,
          durationMs: 1234,
        });
        expect(await repo.listInFlightByProject(`project-${status}`)).toEqual([]);
      }

      const completed = await repo.findBuildSessionByDeploymentId("dep-cancelled");
      expect(await repo.sweepStaleInFlight("Another restart")).toBe(0);
      expect((await repo.findBuildSessionByDeploymentId("dep-cancelled"))?.finishedAt).toEqual(
        completed?.finishedAt,
      );
      expect(await repo.create(replacement)).toMatchObject(replacement);
    } finally {
      await client.close();
    }
  });
});
