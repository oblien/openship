import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createAutoscaleRepo } from "./project-autoscale.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const autoscale = createAutoscaleRepo(db);
const orgId = "org";
const projectId = "proj";

const POLICY = {
  enabled: true,
  targetCpuPercent: 70,
  minReplicas: 1,
  maxReplicas: 6,
  stepSize: 1,
  cooldownSeconds: 120,
  suspendAfterFailures: 3,
};

const seed = async () => {
  await db.insert(schema.organization).values({ id: orgId, name: "Org" });
  await db.insert(schema.projectGroup).values({
    id: "group",
    name: "App",
    slug: "app",
    organizationId: orgId,
  });
  await db.insert(schema.project).values({
    id: projectId,
    organizationId: orgId,
    groupId: "group",
    name: "App",
    slug: "app",
  });
};

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 30_000);
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.delete(schema.projectAutoscaleEvent);
  await db.delete(schema.projectAutoscalePolicy);
  await db.delete(schema.project);
  await db.delete(schema.organization);
  await seed();
});

describe("repos.autoscale", () => {
  it("saves and re-reads one policy per project", async () => {
    const saved = await autoscale.save(projectId, POLICY);
    expect(saved.enabled).toBe(1);
    expect(saved.targetCpuPercent).toBe(70);
    const again = await autoscale.save(projectId, { ...POLICY, targetCpuPercent: 60 });
    expect(again.id).toBe(saved.id);
    expect(again.targetCpuPercent).toBe(60);
    const list = await autoscale.listDue();
    expect(list).toHaveLength(1);
  });

  it("suspension is sticky: only rearm clears it", async () => {
    await autoscale.save(projectId, POLICY);
    await autoscale.suspend(projectId, "a human touched replicas");
    const suspended = await autoscale.get(projectId);
    expect(suspended?.suspendedReason).toBe("a human touched replicas");
    // A second suspend keeps the FIRST and most human-relevant reason.
    await autoscale.suspend(projectId, "something else");
    expect((await autoscale.get(projectId))?.suspendedReason).toBe("a human touched replicas");
    await autoscale.save(projectId, { ...POLICY, rearm: true });
    const rearmed = await autoscale.get(projectId);
    expect(rearmed?.suspendedAt).toBeNull();
    expect(rearmed?.suspendedReason).toBeNull();
  });

  it("saving with rearm clears suspension, saving without keeps it", async () => {
    await autoscale.save(projectId, POLICY);
    await autoscale.suspend(projectId, "manual override");
    await autoscale.save(projectId, { ...POLICY, targetCpuPercent: 80 });
    expect((await autoscale.get(projectId))?.suspendedAt).not.toBeNull();
    const result = await autoscale.save(projectId, { ...POLICY, rearm: true });
    expect(result.suspendedAt).toBeNull();
    expect(result.targetCpuPercent).toBe(70);
  });

  it("enforces the updatedAt CAS so two tabs cannot silently overwrite", async () => {
    const saved = await autoscale.save(projectId, POLICY);
    expect((await autoscale.get(projectId))?.updatedAt.toISOString()).toBe(
      saved.updatedAt.toISOString(),
    );
    await expect(
      autoscale.save(projectId, {
        ...POLICY,
        targetCpuPercent: 50,
        expectedUpdatedAt: new Date(1999, 0, 1).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "AUTOSCALE_POLICY_CONFLICT" });
    expect((await autoscale.get(projectId))?.targetCpuPercent).toBe(70);
    // Stale preconditions must not leak onto a re-arm either.
    await autoscale.suspend(projectId, "manual override");
    await expect(
      autoscale.save(projectId, {
        ...POLICY,
        rearm: true,
        expectedUpdatedAt: new Date(1999, 0, 1).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "AUTOSCALE_POLICY_CONFLICT" });
    expect((await autoscale.get(projectId))?.suspendedAt).not.toBeNull();
    // The row's real updatedAt still passes.
    const ok = await autoscale.save(projectId, {
      ...POLICY,
      rearm: true,
      expectedUpdatedAt: (await autoscale.get(projectId))!.updatedAt.toISOString(),
    });
    expect(ok.suspendedAt).toBeNull();
  });

  it("disable clears pending backoff and suspension intent", async () => {
    await autoscale.save(projectId, POLICY);
    await autoscale.suspend(projectId, "reason");
    await autoscale.save(projectId, { ...POLICY, enabled: false });
    const row = await autoscale.get(projectId);
    expect(row?.enabled).toBe(0);
    expect(row?.suspendedAt).toBeNull();
    expect(row?.nextAttemptAt).toBeNull();
    expect(await autoscale.listDue()).toHaveLength(0);
  });

  it("backoff grows exponentially and a failure streak suspends", async () => {
    await autoscale.save(projectId, POLICY);
    const before = Date.now();
    await autoscale.recordFailure(projectId, 3);
    let row = await autoscale.get(projectId);
    expect(row?.failureCount).toBe(1);
    const gap1 = row!.nextAttemptAt!.getTime() - before;
    expect(gap1).toBeGreaterThan(0);
    await autoscale.recordFailure(projectId, 3);
    row = await autoscale.get(projectId);
    const gap2 = (row?.nextAttemptAt?.getTime() ?? 0) - before;
    expect(gap2).toBeGreaterThan(gap1); // exponential
    await autoscale.recordFailure(projectId, 3);
    row = await autoscale.get(projectId);
    expect(row?.suspendedAt).not.toBeNull();
    expect(row?.suspendedReason).toContain("3 times in a row");
    // The tick's recordSuccess unblocks again on success — but only via rearm
    // once suspended, matching the dashboard handshake.
    await autoscale.save(projectId, { ...POLICY, rearm: true });
    await autoscale.recordSuccess(projectId);
    row = await autoscale.get(projectId);
    expect(row?.failureCount).toBe(0);
    expect(row?.nextAttemptAt).toBeNull();
  });

  it("rejects a stale create from a second tab and does not churn the configuration revision on healthy ticks", async () => {
    const saved = await autoscale.save(projectId, { ...POLICY, expectedUpdatedAt: null });
    await expect(
      autoscale.save(projectId, { ...POLICY, expectedUpdatedAt: null }),
    ).rejects.toMatchObject({ code: "AUTOSCALE_POLICY_CONFLICT" });
    await autoscale.recordSuccess(projectId);
    await autoscale.recordFailure(projectId, 3);
    await autoscale.recordSuccess(projectId);
    expect((await autoscale.get(projectId))!.updatedAt).toEqual(saved.updatedAt);
    await expect(
      autoscale.save(projectId, { ...POLICY, expectedUpdatedAt: saved.updatedAt.toISOString() }),
    ).resolves.toMatchObject({ enabled: 1 });
  });

  it("keeps a bounded event trail and finds the last applied step", async () => {
    await autoscale.save(projectId, POLICY);
    for (let idx = 0; idx < 105; idx++) {
      await autoscale.insertEvent(projectId, {
        createdAt: new Date(Date.now() - 10_000 + idx).toISOString(),
        action: "hold",
        fromReplicas: 2,
        toReplicas: null,
        observedCpuPercent: 50,
        reason: `hold-${idx}`,
      });
    }
    await autoscale.insertEvent(
      projectId,
      {
        createdAt: new Date().toISOString(),
        action: "scale_up",
        fromReplicas: 2,
        toReplicas: 3,
        observedCpuPercent: 90,
        reason: "spike",
      },
      { cooldownSeconds: 120 },
    );
    const events = await autoscale.listEvents(projectId);
    expect(events).toHaveLength(100);
    expect(events[0].action).toBe("scale_up");
    const lastScale = await autoscale.lastScaleEvent(projectId);
    expect(lastScale?.action).toBe("scale_up");
    expect(lastScale?.cooldownSeconds).toBe(120);
    expect(lastScale?.toReplicas).toBe(3);
  });
});
