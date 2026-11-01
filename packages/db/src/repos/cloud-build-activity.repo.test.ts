import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import {
  createCloudBuildActivityRepo,
  reserveCloudBuildActivity,
} from "./cloud-build-activity.repo";
import { createCloudWorkspaceRepo } from "./cloud-workspace.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const builds = createCloudBuildActivityRepo(db);
const workspaces = createCloudWorkspaceRepo(db);
const identity = (id = "a") => ({
  deploymentId: id,
  projectId: `p-${id}`,
  workspaceId: "w",
  organizationId: "org",
});
const resources = { cpuCores: 1, memoryMb: 1024 };
const exclusive = {
  id: "exclusive",
  controllerId: "saas",
  scope: "server",
  startedAt: new Date().toISOString(),
};
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  // Fixtures omit unrelated inventory, while repository ownership checks remain real.
  await client.exec("SET session_replication_role = replica");
});
afterAll(() => client.close());
beforeEach(async () => {
  await db.delete(schema.buildSession);
  await db.delete(schema.cloudBuildActivity);
  await db.delete(schema.deployment);
  await db.delete(schema.project);
  await db.delete(schema.cloudDockerWorkspace);
  await db.delete(schema.cloudWorkspace);
  await db.insert(schema.cloudWorkspace).values({ id: "w", organizationId: "org", name: "Cloud" });
  await db.insert(schema.cloudDockerWorkspace).values({
    ownerWorkspaceId: "w",
    namespace: "ns",
    provisionKey: "key",
    workspaceId: "vm",
    image: "image",
    resources: { cpuCores: 2, memoryMb: 4096, diskMb: 10000 },
    state: "ready",
  });
  for (const id of ["a", "b"]) {
    await db.insert(schema.project).values({
      id: `p-${id}`,
      organizationId: "org",
      groupId: `g-${id}`,
      workspaceId: "w",
      serverId: "server",
      name: id,
      slug: id,
    });
    await db.insert(schema.deployment).values({
      id,
      projectId: `p-${id}`,
      organizationId: "org",
      branch: "main",
      status: "building",
    });
  }
});

it("lets uncapped sibling builds share the host while retaining exclusive lifecycle protection", async () => {
  const resources = { cpuCores: 0, memoryMb: 0 };
  for (const id of ["a", "b"]) {
    await builds.reserve({ ...identity(id), resources });
    expect(await builds.claim(identity(id), `owner-${id}`)).toMatchObject({ resources });
  }
  expect(await builds.listReservations("w", "org")).toHaveLength(2);
  await expect(workspaces.claimActivity("w", "org", exclusive)).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_ACTIVITY_BUSY" });
});

it("reserves capacity without host privileges, activates once, and retains a completion tombstone", async () => {
  await builds.reserve({ ...identity(), buildSessionId: "s", resources });
  expect(await builds.listReservations("w", "org")).toHaveLength(1);
  await workspaces.claimActivity("w", "org", exclusive);
  await expect(builds.claim(identity(), "owner")).rejects.toMatchObject({
    code: "CLOUD_WORKSPACE_ACTIVITY_BUSY",
  });
  await workspaces.releaseActivity("w", "org", exclusive.id, exclusive.controllerId);
  const row = await builds.claim(identity(), "owner");
  expect(row).toMatchObject({ providerWorkspaceId: "vm", buildSessionId: "s", resources });
  expect(await builds.cancelReservation(identity())).toBe(false);
  await expect(builds.claim(identity(), "duplicate")).rejects.toMatchObject({
    code: "CLOUD_BUILD_ACTIVITY_CHANGED",
  });
  await builds.finish(identity(), "owner");
  await expect(builds.claim(identity(), "late")).rejects.toMatchObject({
    code: "CLOUD_BUILD_ACTIVITY_CHANGED",
  });
});

it("keeps the activity-to-execution acknowledgement crash window recoverable", async () => {
  await db.insert(schema.buildSession).values({
    id: "session-a",
    deploymentId: "a",
    projectId: "p-a",
    status: "building",
    startedAt: new Date(),
  });
  await builds.claim(identity(), "owner");
  await builds.finish(identity(), "owner");
  expect((await builds.listUnfinished()).map((row) => row.deploymentId)).toEqual(["a"]);
  expect(await builds.listReservations("w", "org")).toEqual([]);
  await db
    .update(schema.buildSession)
    .set({ finishedAt: new Date() })
    .where(eq(schema.buildSession.id, "session-a"));
  expect(await builds.listUnfinished()).toEqual([]);
});

it("two builds share a host but exclude lifecycle even after capacity release", async () => {
  await Promise.all([builds.claim(identity("a"), "a"), builds.claim(identity("b"), "b")]);
  await builds.recordCommand(identity("a"), "a", { workspaceId: "vm", marker: "a-command" });
  await expect(builds.releaseSlot(identity("a"), "a")).rejects.toMatchObject({
    code: "CLOUD_COMMAND_EXIT_UNCONFIRMED",
  });
  await expect(builds.finish(identity("a"), "a")).rejects.toMatchObject({
    code: "CLOUD_COMMAND_EXIT_UNCONFIRMED",
  });
  await builds.completeCommand(identity("a"), "a", "a-command");
  await builds.releaseSlot(identity("a"), "a");
  expect((await builds.listReservations("w", "org")).map((row) => row.deploymentId)).toEqual(["b"]);
  await builds.recordCommand(identity("a"), "a", { workspaceId: "vm", marker: "deploy-command" });
  await expect(workspaces.claimActivity("w", "org", exclusive, true)).rejects.toMatchObject({
    code: "CLOUD_WORKSPACE_ACTIVITY_BUSY",
  });
  await builds.completeCommand(identity("a"), "a", "deploy-command");
  await builds.finish(identity("a"), "a");
  await expect(workspaces.claimActivity("w", "org", exclusive)).rejects.toMatchObject({
    code: "CLOUD_WORKSPACE_ACTIVITY_BUSY",
  });
  await builds.finish(identity("b"), "b");
  await expect(workspaces.claimActivity("w", "org", exclusive, true)).resolves.toMatchObject({
    id: "exclusive",
  });
});

it("recovery fences stale owners and never clears sibling commands", async () => {
  for (const id of ["a", "b"]) {
    await builds.claim(identity(id), id);
    await builds.recordCommand(identity(id), id, { workspaceId: "vm", marker: id });
  }
  await builds.takeRecoveryOwnership(identity(), "recovery");
  await expect(builds.completeCommand(identity(), "a", "a")).rejects.toMatchObject({
    code: "CLOUD_BUILD_ACTIVITY_CHANGED",
  });
  await expect(
    builds.recordCommand(identity(), "a", { workspaceId: "vm", marker: "late" }),
  ).rejects.toThrow();
  await expect(builds.finish(identity(), "a")).rejects.toThrow();
  await builds.completeCommand(identity(), "recovery", "a");
  await builds.finish(identity(), "recovery");
  expect((await builds.find(identity("b")))?.commands).toEqual([
    { workspaceId: "vm", marker: "b" },
  ]);
});

it("checks tenant/project/provider identity and keeps linked workspaces exclusive", async () => {
  await expect(builds.claim({ ...identity(), organizationId: "other" }, "x")).rejects.toThrow();
  await expect(builds.claim({ ...identity(), projectId: "p-b" }, "x")).rejects.toMatchObject({
    code: "BUILD_OWNERSHIP_MISMATCH",
  });
  await builds.claim(identity(), "a");
  await expect(
    builds.recordCommand(identity(), "a", { workspaceId: "other", marker: "x" }),
  ).rejects.toMatchObject({ code: "CLOUD_SERVER_IDENTITY_MISMATCH" });
  await db
    .update(schema.cloudWorkspace)
    .set({
      remote: {
        apiUrl: "https://cloud",
        userId: "u",
        organizationId: "org",
        serverId: "s",
        workspaceId: "vm",
      },
    })
    .where(eq(schema.cloudWorkspace.id, "w"));
  await expect(builds.claim(identity("b"), "b")).rejects.toMatchObject({
    code: "CLOUD_BUILD_ACTIVITY_LOCAL_ONLY",
  });
});

it("reservation rolls back with the deployment claim transaction and can only cancel before ownership", async () => {
  await expect(
    db.transaction(async (tx) => {
      await reserveCloudBuildActivity(tx, identity(), resources);
      throw new Error("claim failed");
    }),
  ).rejects.toThrow("claim failed");
  expect(await builds.find(identity())).toBeUndefined();
  await builds.reserve({ ...identity(), resources: null });
  expect(await builds.takeRecoveryOwnership(identity(), "recovery")).toBeUndefined();
  expect(await builds.cancelReservation(identity())).toBe(true);
  expect(await builds.listReservations("w", "org")).toEqual([]);
  await expect(builds.claim(identity(), "late")).rejects.toThrow();
});

it("serializes racing exclusive and shared claims on the workspace row", async () => {
  const results = await Promise.allSettled([
    builds.claim(identity(), "a"),
    workspaces.claimActivity("w", "org", exclusive),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
});

it("does not let a later deployment bypass a crashed same-project activity", async () => {
  await builds.claim(identity(), "old-owner");
  await builds.recordCommand(identity(), "old-owner", { workspaceId: "vm", marker: "old" });
  await db.update(schema.deployment).set({ status: "failed" }).where(eq(schema.deployment.id, "a"));
  await db.insert(schema.deployment).values({
    id: "new",
    projectId: "p-a",
    organizationId: "org",
    branch: "main",
    status: "building",
  });
  await expect(
    builds.claim({ ...identity(), deploymentId: "new" }, "new-owner"),
  ).rejects.toMatchObject({ code: "CLOUD_BUILD_PROJECT_BUSY" });
});

it("lists unfinished reservations and activities even after slot release, with stable paging", async () => {
  await builds.reserve({ ...identity(), resources });
  await builds.claim(identity("b"), "b");
  await builds.releaseSlot(identity("b"), "b");
  const all = await builds.listUnfinished({ limit: 10 });
  expect(all.map((row) => row.deploymentId)).toEqual(["a", "b"]);
  expect(
    (await builds.listUnfinished({ limit: 1, offset: 1 })).map((row) => row.deploymentId),
  ).toEqual(["b"]);
  expect((await builds.listReservations("w", "org")).map((row) => row.deploymentId)).toEqual(["a"]);
  await builds.cancelReservation(identity());
  expect((await builds.listUnfinished()).map((row) => row.deploymentId)).toEqual(["b"]);
  await builds.finish(identity("b"), "b");
  expect(await builds.listUnfinished()).toEqual([]);
});

it("lists all scoped unfinished activity for backup admission, including released slots and pending workers", async () => {
  await builds.reserve({ ...identity(), resources });
  await builds.claim(identity("b"), "b");
  await builds.releaseSlot(identity("b"), "b");
  expect((await builds.listActive("w", "org")).map((row) => row.deploymentId)).toEqual(["a", "b"]);
  expect((await builds.listReservations("w", "org")).map((row) => row.deploymentId)).toEqual(["a"]);
  expect(await builds.listActive("w", "other-org")).toEqual([]);
  expect(await builds.listActive("other-workspace", "org")).toEqual([]);
  await builds.cancelReservation(identity());
  expect((await builds.listActive("w", "org")).map((row) => row.deploymentId)).toEqual(["b"]);
  await builds.finish(identity("b"), "b");
  expect(await builds.listActive("w", "org")).toEqual([]);
});

it.each([
  { cpuCores: 0.5, memoryMb: 4096 },
  { cpuCores: 2, memoryMb: 512 },
  { cpuCores: 2, memoryMb: 1024 }, // Fits raw RAM, but not required host headroom.
])("rejects activation when resize changed capacity to %j after reservation", async (capacity) => {
  await builds.reserve({ ...identity(), resources });
  await workspaces.claimActivity("w", "org", exclusive, true);
  await db.update(schema.cloudDockerWorkspace).set({ resources: { ...capacity, diskMb: 10000 } });
  await workspaces.releaseActivity("w", "org", exclusive.id, exclusive.controllerId);
  await expect(builds.claim(identity(), "owner")).rejects.toMatchObject({
    code: "CLOUD_WORKSPACE_BUILD_CAPACITY",
  });
  expect(await builds.find(identity())).toMatchObject({
    ownerToken: null,
    startedAt: null,
    providerWorkspaceId: null,
  });
  expect(await builds.cancelReservation(identity())).toBe(true);
});

it("prevents old reservations collectively overallocating a downsized binding", async () => {
  for (const id of ["a", "b"]) await builds.reserve({ ...identity(id), resources });
  await db
    .update(schema.cloudDockerWorkspace)
    .set({ workspaceId: "resized-vm", resources: { cpuCores: 1, memoryMb: 4096, diskMb: 10000 } });
  expect(await builds.claim(identity(), "a")).toMatchObject({
    providerWorkspaceId: "resized-vm",
    resources,
  });
  await expect(builds.claim(identity("b"), "b")).rejects.toMatchObject({
    code: "CLOUD_WORKSPACE_BUILD_CAPACITY",
  });
  await builds.releaseSlot(identity(), "a");
  expect(await builds.claim(identity("b"), "b")).toMatchObject({
    providerWorkspaceId: "resized-vm",
    resources,
  });
});

it("freezes exclusive preparation at reservation and preserves it after slot release", async () => {
  const input = { ...identity(), buildSessionId: "session", resources, exclusivePreparation: true };
  expect(await builds.reserve(input)).toMatchObject({ exclusivePreparation: true });
  expect(await builds.reserve(input)).toMatchObject({ exclusivePreparation: true });
  await expect(builds.reserve({ ...input, exclusivePreparation: false })).rejects.toMatchObject({
    code: "CLOUD_BUILD_ACTIVITY_CHANGED",
  });
  await builds.claim(identity(), "owner");
  await builds.releaseSlot(identity(), "owner");
  expect(await builds.listReservations("w", "org")).toEqual([]);
  expect(await builds.listActive("w", "org")).toMatchObject([
    { deploymentId: "a", exclusivePreparation: true },
  ]);
  await builds.reserve({ ...identity("b"), resources: null });
  expect(await builds.find(identity("b"))).toMatchObject({ exclusivePreparation: false });
});

it("accepts the exclusive preparation flag through the atomic transaction helper", async () => {
  await db.transaction((tx) =>
    reserveCloudBuildActivity(tx, identity(), resources, "session", true),
  );
  expect(await builds.find(identity())).toMatchObject({
    buildSessionId: "session",
    exclusivePreparation: true,
  });
});

it("fences legacy exclusive claims through the singleton until the last shared execution finishes", async () => {
  // Simulate the OLD repo protocol: no shared-table assertion or knowledge.
  const legacyClaim = () =>
    db.transaction(async (tx) => {
      const [workspace] = await tx
        .select()
        .from(schema.cloudWorkspace)
        .where(eq(schema.cloudWorkspace.id, "w"))
        .for("update");
      if (
        workspace!.activity &&
        (workspace!.activity.id !== exclusive.id ||
          workspace!.activity.controllerId !== exclusive.controllerId ||
          workspace!.activity.scope !== exclusive.scope)
      )
        throw new Error("legacy activity busy");
      await tx
        .update(schema.cloudWorkspace)
        .set({ activity: exclusive })
        .where(eq(schema.cloudWorkspace.id, "w"));
    });
  await builds.claim(identity(), "a");
  const barrier = (await workspaces.findById("w"))!.activity;
  expect(barrier).toMatchObject({
    id: "cloud-builds:w",
    controllerId: "saas",
    scope: "cloud-builds",
  });
  await builds.claim(identity("b"), "b");
  expect((await workspaces.findById("w"))!.activity).toEqual(barrier);
  await expect(legacyClaim()).rejects.toThrow("legacy activity busy");
  await builds.releaseSlot(identity(), "a");
  await builds.finish(identity(), "a");
  await expect(legacyClaim()).rejects.toThrow("legacy activity busy");
  await builds.recordCommand(identity("b"), "b", { workspaceId: "vm", marker: "unresolved" });
  await expect(builds.finish(identity("b"), "b")).rejects.toMatchObject({
    code: "CLOUD_COMMAND_EXIT_UNCONFIRMED",
  });
  expect((await workspaces.findById("w"))!.activity).toEqual(barrier);
  await builds.completeCommand(identity("b"), "b", "unresolved");
  await builds.finish(identity("b"), "b");
  expect((await workspaces.findById("w"))!.activity).toBeNull();
  await expect(legacyClaim()).resolves.toBeUndefined();
});

it("does not mistake another controller's similarly scoped activity for the shared barrier", async () => {
  await workspaces.claimActivity("w", "org", {
    ...exclusive,
    id: "cloud-builds:w",
    scope: "cloud-builds",
    controllerId: "other",
  });
  await expect(builds.claim(identity(), "a")).rejects.toMatchObject({
    code: "CLOUD_WORKSPACE_ACTIVITY_BUSY",
  });
});

it("refuses reservations during manual maintenance but permits the genuine shared singleton", async () => {
  await workspaces.claimActivity("w", "org", exclusive);
  await expect(builds.reserve({ ...identity(), resources })).rejects.toMatchObject({
    code: "CLOUD_WORKSPACE_ACTIVITY_BUSY",
  });
  expect(await builds.find(identity())).toBeUndefined();
  await workspaces.releaseActivity("w", "org", exclusive.id, exclusive.controllerId);
  await builds.claim(identity(), "worker");
  expect(await builds.reserve({ ...identity("b"), resources })).toMatchObject({
    deploymentId: "b",
    ownerToken: null,
  });
});

it.each(["queued", "running", "failed"] as const)(
  "defers reservations while workspace operation is %s",
  async (status) => {
    await db
      .update(schema.cloudWorkspace)
      .set({
        operation: {
          id: "maintenance",
          kind: "resize",
          status,
          requestedAt: new Date().toISOString(),
          attempts: 0,
          nextAttemptAt: null,
          error: null,
          logs: [],
        },
      })
      .where(eq(schema.cloudWorkspace.id, "w"));
    await expect(builds.reserve({ ...identity(), resources })).rejects.toMatchObject({
      code: "CLOUD_WORKSPACE_ACTIVITY_BUSY",
    });
    expect(await builds.find(identity())).toBeUndefined();
  },
);
