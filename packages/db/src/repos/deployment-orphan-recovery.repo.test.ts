import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createEncryption } from "../encryption";
import { createDeploymentRepo } from "./deployment.repo";

const input = {
  deploymentId: "dep",
  buildSessionId: "build",
  projectId: "project",
  organizationId: "org",
};
const logs = [
  { timestamp: "2026-01-01T00:00:00Z", level: "info", message: "Original build output" },
];

describe("fenced orphaned build sessions (#1682)", () => {
  const client = new PGlite("memory://");
  const db = drizzle(client, { schema });
  const repo = createDeploymentRepo(db, createEncryption("orphan-session-test"));
  beforeAll(async () => {
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
    await client.exec("SET session_replication_role = replica");
  });
  afterAll(() => client.close());
  beforeEach(async () => {
    await db.delete(schema.cloudBuildActivity);
    await db.delete(schema.buildSession);
    await db.delete(schema.deployment);
    await db.delete(schema.project);
    await db.insert(schema.project).values({
      id: "project",
      organizationId: "org",
      groupId: "group",
      name: "App",
      slug: "app",
      serverId: "ssh-server",
      activeDeploymentId: "dep",
    });
    await db.insert(schema.deployment).values({
      id: "dep",
      projectId: "project",
      organizationId: "org",
      branch: "main",
      status: "queued",
      containerId: "retained-runtime",
    });
    await db.insert(schema.buildSession).values({
      id: "build",
      deploymentId: "dep",
      projectId: "project",
      status: "queued",
      logs,
      durationMs: 1234,
    });
  });
  async function claim(status = "cancelled", executionFenced = true) {
    expect(await repo.claimBuildExecution({ ...input, executionFenced })).toBe("claimed");
    await db.update(schema.deployment).set({ status }).where(eq(schema.deployment.id, "dep"));
    await db.update(schema.buildSession).set({ status }).where(eq(schema.buildSession.id, "build"));
  }

  it.each(["cancelled", "failed", "ready", "partial_failure", "reconciling", "no_changes"])(
    "closes the abandoned %s session while preserving the release, logs and billed time",
    async (status) => {
      await claim(status);
      const deployment = await repo.findById("dep");
      const [project] = await db.select().from(schema.project);
      expect((await repo.listInFlightByProject("project")).map((d) => d.id)).toEqual(["dep"]);
      expect(await repo.recoverFencedBuildExecution(input)).toBe(true);
      expect(await repo.findById("dep")).toEqual(deployment);
      expect(await db.select().from(schema.project)).toEqual([project]);
      expect(await repo.findBuildSession("build")).toMatchObject({
        status,
        logs,
        durationMs: 1234,
        finishedAt: expect.any(Date),
      });
      expect(await repo.listInFlightByProject("project")).toEqual([]);
      expect(await repo.hasLiveBuildExecution("dep", "project")).toBe(false);
      expect(await repo.recoverFencedBuildExecution(input)).toBe(false);
    },
  );

  it("leaves legacy workers fenced out of automatic recovery during rolling upgrades", async () => {
    await claim("cancelled", false);
    expect(await repo.recoverFencedBuildExecution(input)).toBe(false);
    expect(await repo.hasLiveBuildExecution("dep", "project")).toBe(true);
    expect(await repo.deleteDeployment("dep")).toBe(false);
  });

  it.each(["queued", "building", "deploying"])(
    "requires explicit interrupted-worker recovery for %s",
    async (status) => {
      await claim(status);
      expect(await repo.recoverFencedBuildExecution(input)).toBe(false);
      expect(await repo.recoverFencedBuildExecution({ ...input, recoverInterrupted: true })).toBe(
        true,
      );
      expect(await repo.findById("dep")).toMatchObject({
        status: "failed",
        errorCode: "DEPLOYMENT_INTERRUPTED",
        containerId: "retained-runtime",
      });
      expect(await repo.findBuildSession("build")).toMatchObject({
        status: "failed",
        durationMs: 1234,
        logs,
        finishedAt: expect.any(Date),
      });
    },
  );

  it.each(["organizationId", "projectId", "deploymentId", "buildSessionId"] as const)(
    "rejects a different %s",
    async (field) => {
      await claim();
      expect(
        await repo.recoverFencedBuildExecution({
          ...input,
          [field]: "another-tenant-or-work-item",
        }),
      ).toBe(false);
      expect(await repo.hasLiveBuildExecution("dep", "project")).toBe(true);
    },
  );

  it("never recovers an unstarted session", async () => {
    await db.update(schema.buildSession).set({ executionFenced: true });
    expect(await repo.recoverFencedBuildExecution({ ...input, recoverInterrupted: true })).toBe(
      false,
    );
    expect(await repo.findBuildSession("build")).toMatchObject({
      startedAt: null,
      finishedAt: null,
    });
  });

  it("does not rewrite an already-finished session", async () => {
    await claim();
    await repo.acknowledgeBuildExecutionFinished("build");
    const before = await repo.findBuildSession("build");
    expect(await repo.recoverFencedBuildExecution(input)).toBe(false);
    expect(await repo.findBuildSession("build")).toEqual(before);
  });

  it("leaves managed work to command-aware recovery, even after a destination edit", async () => {
    await claim();
    await db.insert(schema.cloudBuildActivity).values({
      deploymentId: "dep",
      projectId: "project",
      buildSessionId: "build",
      workspaceId: "workspace",
      organizationId: "org",
    });
    expect(await repo.recoverFencedBuildExecution(input)).toBe(false);
    await db.delete(schema.cloudBuildActivity);
    await db.update(schema.project).set({ workspaceId: "workspace" });
    expect(await repo.recoverFencedBuildExecution(input)).toBe(false);
    expect(await repo.hasLiveBuildExecution("dep", "project")).toBe(true);
  });

  it("acknowledges a dead worker while preserving a committing handover for its own recovery path", async () => {
    await claim("building");
    await db.update(schema.deployment).set({ roleHandover: { phase: "committing" } as never });
    expect(await repo.recoverFencedBuildExecution({ ...input, recoverInterrupted: true })).toBe(
      true,
    );
    expect(await repo.hasLiveBuildExecution("dep", "project")).toBe(false);
    expect(await repo.findById("dep")).toMatchObject({
      status: "building",
      errorCode: null,
      roleHandover: { phase: "committing" },
    });
    // Publication remains pending, but its own recovery can now proceed.
    expect((await repo.listInFlightByProject("project")).map((d) => d.id)).toEqual(["dep"]);
    expect((await repo.listPendingRoleHandovers("project")).map((d) => d.id)).toEqual(["dep"]);
  });

  it("rolls the deployment transition back if completion cannot be recorded", async () => {
    await claim("building");
    await client.exec(
      "ALTER TABLE build_session ADD CONSTRAINT recovery_write_failure CHECK (finished_at IS NULL)",
    );
    try {
      await expect(
        repo.recoverFencedBuildExecution({ ...input, recoverInterrupted: true }),
      ).rejects.toThrow();
      expect(await repo.findById("dep")).toMatchObject({ status: "building", errorCode: null });
      expect(await repo.hasLiveBuildExecution("dep", "project")).toBe(true);
    } finally {
      await client.exec("ALTER TABLE build_session DROP CONSTRAINT recovery_write_failure");
    }
  });

  it("unblocks deletion and new deployment admission without deleting the project itself", async () => {
    await claim();
    const replacement = {
      id: "next",
      projectId: "project",
      organizationId: "org",
      branch: "main",
      status: "queued",
    };
    expect(await repo.create(replacement)).toBeUndefined();
    expect(await repo.recoverFencedBuildExecution(input)).toBe(true);
    expect(await repo.create(replacement)).toMatchObject({ id: "next" });
    expect(await repo.deleteDeployment("dep")).toBe(true);
    expect(await db.select().from(schema.project)).toHaveLength(1);
  });

  it("pages eligible workers without skipping rows completed by another replica", async () => {
    await claim();
    await db.update(schema.buildSession).set({ startedAt: new Date(0) });
    await db.insert(schema.buildSession).values([
      {
        id: "build-2",
        deploymentId: "dep",
        projectId: "project",
        startedAt: new Date(0),
        executionFenced: true,
      },
      {
        id: "build-3",
        deploymentId: "dep",
        projectId: "project",
        startedAt: new Date(0),
        executionFenced: true,
      },
      { id: "legacy", deploymentId: "dep", projectId: "project", startedAt: new Date(0) },
      {
        id: "recent",
        deploymentId: "dep",
        projectId: "project",
        startedAt: new Date(),
        executionFenced: true,
      },
    ]);
    expect(
      (await repo.listUnfinishedFencedBuildExecutions(undefined, 2)).map((s) => s.buildSessionId),
    ).toEqual(["build", "build-2"]);
    await repo.acknowledgeBuildExecutionFinished("build");
    expect(
      (await repo.listUnfinishedFencedBuildExecutions("build-2", 2)).map((s) => s.buildSessionId),
    ).toEqual(["build-3"]);
  });
});
