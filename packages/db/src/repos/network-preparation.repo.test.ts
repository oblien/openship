import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import {
  managedOperationFixture,
  managedPreparationFixture,
} from "../../../contracts/test/managed-network-fixtures";
import * as schema from "../schema";
import { createNetworkPreparationRepo } from "./network-preparation.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createNetworkPreparationRepo(db);
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
});
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.delete(schema.managedNetworkPreparation);
  await db.delete(schema.organization);
  await db.insert(schema.organization).values([
    { id: "org-a", name: "A" },
    { id: "org-b", name: "B" },
  ]);
});
const fixture = managedPreparationFixture();
const start = (org = "org-a", hash = "same") =>
  repo.start(org, "user", hash, fixture.input, fixture.hosts);
describe("durable network prerequisite preparation", () => {
  it("orders committed progress and retry attempts without advancing for lease heartbeats", async () => {
    await start();
    expect((await repo.get("org-a", fixture.id)).sequence).toBe(1);
    await repo.heartbeat(fixture.id, 1);
    expect((await repo.get("org-a", fixture.id)).sequence).toBe(1);
    await Promise.all([
      repo.progress(fixture.id, 1, fixture.hosts),
      repo.progress(fixture.id, 1, fixture.hosts),
    ]);
    expect((await repo.get("org-a", fixture.id)).sequence).toBe(3);
    await repo.finish(fixture.id, 1, fixture.hosts, null, "Repository unavailable");
    expect((await repo.get("org-a", fixture.id)).sequence).toBe(4);
    const retry = await start();
    expect(retry.preparation.sequence).toBe(5);
    await expect(repo.progress(fixture.id, 1, fixture.hosts)).rejects.toThrow("no longer owns");
    expect((await repo.get("org-a", fixture.id)).sequence).toBe(5);
  });
  it("starts one worker for concurrent requests and binds replay to the same organization and input", async () => {
    const results = await Promise.all([start(), start()]);
    expect(results.filter((result) => result.started)).toHaveLength(1);
    await expect(start("org-a", "different")).rejects.toThrow("different settings");
    await expect(start("org-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.get("org-b", fixture.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await repo.list("org-b")).toEqual([]);
  });
  it("persists dependency failures and log output and allows an explicit retry", async () => {
    await start();
    const hosts = structuredClone(fixture.hosts);
    hosts[0]!.steps[2]!.status = "failed";
    hosts[0]!.steps[2]!.message = "Package repositories unavailable";
    hosts[0]!.logs.push({
      step: "python3",
      timestamp: new Date().toISOString(),
      level: "error",
      message: "Connection refused",
    });
    await repo.progress(fixture.id, 1, hosts);
    await repo.finish(fixture.id, 1, hosts, null, "Preparation failed");
    const saved = await repo.get("org-a", fixture.id);
    expect(saved.status).toBe("failed");
    expect(saved.hosts[0]!.logs).toHaveLength(1);
    const retry = await start();
    expect(retry.started).toBe(true);
    expect(retry.preparation.generation).toBe(2);
    expect(retry.preparation.hosts[0]!.steps[2]!.message).toBe("Package repositories unavailable");
    expect(await repo.heartbeat(fixture.id, 1)).toBe(false);
    await expect(repo.progress(fixture.id, 1, hosts)).rejects.toThrow("no longer owns");
  });
  it("marks abandoned preparation as interrupted and fences the previous worker after retry", async () => {
    await start();
    await db
      .update(schema.managedNetworkPreparation)
      .set({ leaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.managedNetworkPreparation.id, fixture.id));
    expect((await repo.get("org-a", fixture.id)).status).toBe("interrupted");
    expect(await repo.active(fixture.id, 1)).toBe(false);
    expect(await repo.heartbeat(fixture.id, 1)).toBe(false);
    const retry = await start();
    expect(retry.preparation.generation).toBe(2);
    await expect(
      repo.finish(fixture.id, 1, fixture.hosts, null, "Old worker failed"),
    ).rejects.toThrow("no longer owns");
    expect(await repo.active(fixture.id, 2)).toBe(true);
  });
  it("recovers a restarted exclusive owner immediately while preserving its saved progress", async () => {
    const { preparation } = await start();
    const hosts = structuredClone(fixture.hosts);
    hosts[0]!.steps[0]!.status = "completed";
    hosts[0]!.steps[1]!.status = "running";
    hosts[0]!.logs.push({
      step: "connect",
      level: "info",
      timestamp: new Date().toISOString(),
      message: "Connected",
    });
    await repo.progress(fixture.id, 1, hosts);
    expect(preparation.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    const restarted = createNetworkPreparationRepo(db);
    expect(await restarted.recoverInterrupted(true)).toEqual([
      { id: fixture.id, organizationId: "org-a" },
    ]);
    const stopped = await restarted.get("org-a", fixture.id);
    expect(stopped).toMatchObject({
      status: "interrupted",
      leaseExpiresAt: null,
      sequence: 3,
      generation: 1,
      hosts,
    });
    expect(stopped.error).toContain("restarted");
    expect(await restarted.recoverInterrupted(true)).toEqual([]);
    expect((await restarted.list("org-a"))[0]!.status).toBe("interrupted");
    expect(await repo.heartbeat(fixture.id, 1)).toBe(false);
    await expect(repo.finish(fixture.id, 1, hosts, null, "Late failure")).rejects.toThrow(
      "no longer owns",
    );

    const retry = await start();
    expect(retry.preparation.generation).toBe(2);
    expect(retry.preparation.hosts).toEqual(hosts);
    expect(await repo.interrupt(fixture.id, 1, "Old controller stopped")).toEqual([]);
    expect(await repo.active(fixture.id, 2)).toBe(true);
  });
  it("preserves live shared owners and paused or terminal runs while recovering expired and missing leases", async () => {
    await start();
    await db.insert(schema.managedNetworkPreparation).values(
      ["expired", "missing", "pending", "ready", "failed", "cancelled"].map((id) => ({
        id,
        organizationId: "org-a",
        inputHash: "same",
        input: { ...fixture.input, requestId: id },
        hosts: fixture.hosts,
        createdBy: "user",
        status:
          id === "expired" || id === "missing"
            ? ("preparing" as const)
            : (id as "pending" | "ready" | "failed" | "cancelled"),
        leaseExpiresAt: id === "expired" ? new Date(Date.now() - 1) : null,
      })),
    );
    expect((await repo.recoverInterrupted(false)).map((row) => row.id).sort()).toEqual([
      "expired",
      "missing",
    ]);
    expect(await repo.active(fixture.id, 1)).toBe(true);
    expect(await repo.heartbeat(fixture.id, 1)).toBe(true);
    for (const status of ["pending", "ready", "failed", "cancelled"])
      expect((await repo.get("org-a", status)).status).toBe(status);
    expect(await repo.recoverInterrupted(true)).toEqual([
      { id: fixture.id, organizationId: "org-a" },
    ]);
    for (const status of ["pending", "ready", "failed", "cancelled"])
      expect((await repo.get("org-a", status)).status).toBe(status);
  });
  it("interrupts only the worker generation being stopped and treats a missing lease as abandoned on read", async () => {
    await start();
    expect(await repo.interrupt(fixture.id, 2, "Wrong worker")).toEqual([]);
    expect(await repo.interrupt(fixture.id, 1, "OpenShip stopped")).toEqual([
      { id: fixture.id, organizationId: "org-a" },
    ]);
    expect(await repo.get("org-a", fixture.id)).toMatchObject({
      status: "interrupted",
      error: "OpenShip stopped",
      sequence: 2,
    });
    await start();
    await db
      .update(schema.managedNetworkPreparation)
      .set({ leaseExpiresAt: null })
      .where(eq(schema.managedNetworkPreparation.id, fixture.id));
    expect(await repo.get("org-a", fixture.id)).toMatchObject({
      status: "interrupted",
      sequence: 4,
    });
  });
  it("does not mark prerequisites ready until each server and step has passed", async () => {
    await start();
    await expect(repo.finish(fixture.id, 1, fixture.hosts, fixture.id, null)).rejects.toThrow(
      "Every server prerequisite",
    );
    await expect(repo.finish(fixture.id, 1, [], fixture.id, null)).rejects.toThrow(
      "Every server prerequisite",
    );
    const ready = fixture.hosts.map((host) => ({
      ...host,
      hostIdentity: `host:${host.serverId}`,
      steps: host.steps.map((step) => ({ ...step, status: "completed" as const })),
    }));
    await repo.finish(fixture.id, 1, ready, fixture.id, null);
    expect((await repo.get("org-a", fixture.id)).status).toBe("ready");
    expect((await start()).started).toBe(false);
    expect(await repo.active(fixture.id, 1)).toBe(false);
  });
  it("lists saved preparations and cascades organization deletion", async () => {
    await start();
    expect(await repo.list("org-a")).toHaveLength(1);
    await db.delete(schema.organization).where(eq(schema.organization.id, "org-a"));
    expect(await repo.list("org-a")).toEqual([]);
  });
  it("keeps unfinished setup visible when newer preparations have already been applied", async () => {
    await start();
    await repo.finish(fixture.id, 1, fixture.hosts, null, "A server needs attention");
    const operation = managedOperationFixture();
    const completed = Array.from({ length: 21 }, (_, index) => ({
      id: `completed-${index}`,
      organizationId: "org-a",
      clusterId: operation.clusterId,
      inputHash: "same",
      planHash: operation.planHash,
      plan: operation.plan,
      hosts: operation.hosts,
      status: "succeeded" as const,
      createdBy: "user",
    }));
    await db.insert(schema.managedNetworkOperation).values(completed);
    await db.insert(schema.managedNetworkPreparation).values(
      completed.map((operation) => ({
        id: operation.id,
        organizationId: "org-a",
        inputHash: "same",
        input: { ...fixture.input, requestId: operation.id },
        hosts: fixture.hosts,
        status: "ready" as const,
        operationId: operation.id,
        createdBy: "user",
        createdAt: new Date(Date.now() + 1000),
      })),
    );
    const pending = await repo.list("org-a");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: fixture.id,
      status: "failed",
      name: fixture.input.name,
      serverCount: fixture.hosts.length,
    });
    expect(pending[0]).not.toHaveProperty("hosts");
    expect(pending[0]).not.toHaveProperty("input");
  });
});
