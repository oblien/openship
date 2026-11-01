import { beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import * as schema from "../schema";
import { createEncryption } from "../encryption";
import { createDeploymentRepo } from "./deployment.repo";
import { createCloudBuildActivityRepo } from "./cloud-build-activity.repo";
const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const encryption = createEncryption("cloud-build-queue-test");
const repo = createDeploymentRepo(db, encryption);
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await client.exec("SET session_replication_role = replica;");
});
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.delete(schema.backupPolicy);
  await db.delete(schema.cloudBuildActivity);
  await db.delete(schema.cloudDockerWorkspace);
  await db.delete(schema.cloudWorkspace);
  await db.delete(schema.buildSession);
  await db.delete(schema.deployment);
  await db.delete(schema.project);
  for (const [id, workspaceId, organizationId] of [
    ["a", "w1", "org1"],
    ["b", "w2", "org1"],
    ["c", "w3", "org2"],
  ]) {
    await db
      .insert(schema.cloudWorkspace)
      .values({ id: workspaceId, organizationId, name: workspaceId });
    await db.insert(schema.project).values({
      id,
      workspaceId,
      serverId: `server-${id}`,
      organizationId,
      groupId: `g-${id}`,
      name: id,
      slug: id,
    });
    await db.insert(schema.deployment).values({
      id: `dep-${id}`,
      projectId: id,
      organizationId,
      branch: "main",
      status: "queued",
      meta: { marker: "keep" },
    });
    await db
      .insert(schema.buildSession)
      .values({ id: `session-${id}`, projectId: id, deploymentId: `dep-${id}`, status: "queued" });
  }
});
it("recovers submitted work from durable state, but never starts untouched drafts or cancelled jobs", async () => {
  await repo.requestCloudBuild("dep-a", "org1");
  await repo.requestCloudBuild("dep-c", "org1"); // Wrong organization cannot submit another customer's job.
  const restarted = createDeploymentRepo(db, encryption);
  expect((await restarted.listRequestedCloudBuilds()).map((row) => row.id)).toEqual(["dep-a"]);
  expect((await restarted.findById("dep-a"))?.meta).toMatchObject({
    marker: "keep",
    cloudBuildRequested: true,
  });
  await db
    .update(schema.deployment)
    .set({ status: "cancelled" })
    .where(eq(schema.deployment.id, "dep-a"));
  expect(await restarted.listRequestedCloudBuilds()).toEqual([]);
});
it("counts active leases per server until cleanup acknowledges completion, even after cancellation", async () => {
  await repo.claimBuildExecution({
    deploymentId: "dep-a",
    buildSessionId: "session-a",
    projectId: "a",
    organizationId: "org1",
  });
  expect(await repo.countActiveCloudBuilds("w1", "org1")).toBe(1);
  expect(await repo.countActiveCloudBuilds("w2", "org1")).toBe(0);
  expect(await repo.countActiveCloudBuilds("w1", "org2")).toBe(0);
  await db
    .update(schema.deployment)
    .set({ status: "cancelled" })
    .where(eq(schema.deployment.id, "dep-a"));
  expect(await repo.countActiveCloudBuilds("w1", "org1")).toBe(1);
  await repo.updateBuildSession("session-a", { finishedAt: new Date() });
  expect(await repo.countActiveCloudBuilds("w1", "org1")).toBe(0);
});
it("keeps workspace queues separate and excludes projects claimed for deletion", async () => {
  await repo.requestCloudBuild("dep-a", "org1");
  await repo.requestCloudBuild("dep-b", "org1");
  expect((await repo.listRequestedCloudBuilds("w1")).map((row) => row.id)).toEqual(["dep-a"]);
  await db
    .update(schema.project)
    .set({ deletionInProgress: true })
    .where(eq(schema.project.id, "a"));
  expect(await repo.listRequestedCloudBuilds("w1")).toEqual([]);
});

it("orders by first submission, preserves metadata and does not move retries to the back", async () => {
  await db
    .update(schema.deployment)
    .set({ createdAt: new Date("2000-01-01") })
    .where(eq(schema.deployment.id, "dep-a"));
  await db.update(schema.project).set({ workspaceId: "w1" }).where(eq(schema.project.id, "b"));
  await repo.requestCloudBuild("dep-b", "org1");
  // Separate submission times deterministically even on millisecond clocks.
  await db
    .update(schema.deployment)
    .set({ meta: { marker: "keep", cloudBuildRequested: true, cloudBuildRequestedAt: 1700000000 } })
    .where(eq(schema.deployment.id, "dep-b"));
  const first = (await repo.findById("dep-b"))!.meta;
  await repo.requestCloudBuild("dep-a", "org1");
  await repo.requestCloudBuild("dep-b", "org1");
  expect((await repo.findById("dep-b"))!.meta).toEqual(first);
  expect((await repo.listRequestedCloudBuilds("w1")).map((row) => row.id)).toEqual([
    "dep-b",
    "dep-a",
  ]);
});

it("interleaves workspaces before the global limit while retaining workspace FIFO", async () => {
  const old = new Date("2000-01-01");
  await db.update(schema.deployment).set({ meta: { marker: "keep", cloudBuildRequested: true } });
  await db
    .update(schema.deployment)
    .set({ createdAt: old })
    .where(eq(schema.deployment.id, "dep-a"));
  await db.insert(schema.project).values({
    id: "a2",
    workspaceId: "w1",
    serverId: "server-a",
    organizationId: "org1",
    groupId: "g-a2",
    name: "a2",
    slug: "a2",
  });
  await db.insert(schema.deployment).values({
    id: "dep-a2",
    projectId: "a2",
    organizationId: "org1",
    branch: "main",
    status: "queued",
    createdAt: old,
    meta: { cloudBuildRequested: true },
  });
  await db
    .insert(schema.buildSession)
    .values({ id: "session-a2", deploymentId: "dep-a2", projectId: "a2", status: "queued" });
  expect((await repo.listRequestedCloudBuilds(undefined, 3)).map((row) => row.id)).toEqual([
    "dep-a",
    "dep-b",
    "dep-c",
  ]);
  expect((await repo.listRequestedCloudBuilds("w1", 2)).map((row) => row.id)).toEqual([
    "dep-a",
    "dep-a2",
  ]);
  expect(await repo.listRequestedCloudBuilds(undefined, 0)).toEqual([]);
  const paged = [
    ...(await repo.listRequestedCloudBuilds(undefined, 2)),
    ...(await repo.listRequestedCloudBuilds(undefined, 2, 2)),
  ];
  expect(paged.map((row) => row.id)).toEqual(["dep-a", "dep-b", "dep-c", "dep-a2"]);
  expect(await repo.listRequestedCloudBuilds(undefined, 2, 4)).toEqual([]);
});

it("handles legacy and malformed submission clocks without losing metadata", async () => {
  await db
    .update(schema.deployment)
    .set({ meta: { cloudBuildRequested: true, marker: "keep" } })
    .where(eq(schema.deployment.id, "dep-a"));
  await repo.requestCloudBuild("dep-a", "org1");
  const legacy = (await repo.findById("dep-a"))!;
  expect(legacy.meta).toMatchObject({
    marker: "keep",
    cloudBuildRequestedAt: legacy.createdAt.getTime() / 1000,
  });
  await db
    .update(schema.deployment)
    .set({ meta: { cloudBuildRequested: true, cloudBuildRequestedAt: "invalid" } })
    .where(eq(schema.deployment.id, "dep-b"));
  expect(await repo.listRequestedCloudBuilds()).toHaveLength(2);
  await db.update(schema.deployment).set({ meta: null }).where(eq(schema.deployment.id, "dep-c"));
  await repo.requestCloudBuild("dep-c", "org2");
  expect((await repo.findById("dep-c"))?.meta).toMatchObject({
    cloudBuildRequested: true,
    cloudBuildRequestedAt: expect.any(Number),
  });
});

it("excludes queue heads with missing, finished, claimed or mismatched sessions", async () => {
  await repo.requestCloudBuild("dep-a", "org1");
  await db.delete(schema.buildSession).where(eq(schema.buildSession.id, "session-a"));
  expect(await repo.listRequestedCloudBuilds()).toEqual([]);
  await db.insert(schema.buildSession).values({
    id: "replacement",
    projectId: "a",
    deploymentId: "dep-a",
    status: "queued",
    finishedAt: new Date(),
  });
  expect(await repo.listRequestedCloudBuilds()).toEqual([]);
  await repo.updateBuildSession("replacement", { finishedAt: null, startedAt: new Date() });
  expect(await repo.listRequestedCloudBuilds()).toEqual([]);
  await repo.updateBuildSession("replacement", { startedAt: null, projectId: "b" });
  expect(await repo.listRequestedCloudBuilds()).toEqual([]);
  await repo.updateBuildSession("replacement", { projectId: "a" });
  await db.update(schema.project).set({ organizationId: "org2" }).where(eq(schema.project.id, "a"));
  expect(await repo.listRequestedCloudBuilds()).toEqual([]);
});

it("a backlog larger than the default page cannot hide another workspace", async () => {
  const ids = Array.from({ length: 201 }, (_, i) => `backlog-${String(i).padStart(3, "0")}`);
  await db.insert(schema.project).values(
    ids.map((id) => ({
      id,
      workspaceId: "w1",
      serverId: "server-a",
      organizationId: "org1",
      groupId: `g-${id}`,
      name: id,
      slug: id,
    })),
  );
  await db.insert(schema.deployment).values(
    ids.map((id) => ({
      id: `dep-${id}`,
      projectId: id,
      organizationId: "org1",
      branch: "main",
      status: "queued",
      createdAt: new Date("2000-01-01"),
      meta: { cloudBuildRequested: true },
    })),
  );
  await db.insert(schema.buildSession).values(
    ids.map((id) => ({
      id: `session-${id}`,
      deploymentId: `dep-${id}`,
      projectId: id,
      status: "queued",
    })),
  );
  await repo.requestCloudBuild("dep-b", "org1");
  const first = await repo.listRequestedCloudBuilds();
  expect(first).toHaveLength(200);
  expect(first[1].id).toBe("dep-b");
  const second = await repo.listRequestedCloudBuilds(undefined, 200, 200);
  expect(second).toHaveLength(2);
  expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(202);
  await db.update(schema.buildSession).set({ startedAt: new Date("2000-01-01") });
  expect(await repo.listUnfinishedCloudBuildExecutions(500)).toHaveLength(100);
});

it("persists wait information only for the organization's queued deployment", async () => {
  await repo.requestCloudBuild("dep-a", "org1");
  const info = { reason: "concurrency" as const, limit: 2, message: "Waiting for a build slot" };
  expect(await repo.setCloudBuildQueueWait("dep-a", "org2", info)).toBe(false);
  expect(await repo.setCloudBuildQueueWait("dep-a", "org1", info)).toBe(true);
  const restarted = createDeploymentRepo(db, encryption);
  const before = (await restarted.findById("dep-a"))!.meta;
  expect(before).toMatchObject({
    marker: "keep",
    cloudBuildRequested: true,
    cloudBuildQueueReason: "concurrency",
    cloudBuildQueue: info,
  });
  const next = { reason: "resources" as const, limit: null, message: "Waiting for capacity" };
  expect(await repo.setCloudBuildQueueWait("dep-a", "org1", next)).toBe(true);
  expect((await restarted.findById("dep-a"))!.meta).toMatchObject({
    marker: "keep",
    cloudBuildRequested: true,
    cloudBuildQueueReason: "resources",
    cloudBuildQueue: next,
  });
  await repo.claimBuildExecution({
    deploymentId: "dep-a",
    buildSessionId: "session-a",
    projectId: "a",
    organizationId: "org1",
  });
  expect(await repo.setCloudBuildQueueWait("dep-a", "org1", info)).toBe(false);
  await db
    .update(schema.deployment)
    .set({ status: "cancelled" })
    .where(eq(schema.deployment.id, "dep-a"));
  expect(await repo.setCloudBuildQueueWait("dep-a", "org1", info)).toBe(false);
  expect((await restarted.findById("dep-a"))!.meta).toMatchObject({ cloudBuildQueue: next });
});

it("returns the workspace FIFO position, scoped to organization and eligible queue entries", async () => {
  expect(await repo.getCloudBuildQueuePosition("dep-a", "org1")).toBeNull();
  await db.update(schema.project).set({ workspaceId: "w1" });
  await db
    .update(schema.deployment)
    .set({ meta: { cloudBuildRequested: true, cloudBuildRequestedAt: 1700000000 } });
  expect(await repo.getCloudBuildQueuePosition("dep-a", "org1")).toBe(1);
  expect(await repo.getCloudBuildQueuePosition("dep-b", "org1")).toBe(2);
  expect(await repo.getCloudBuildQueuePosition("dep-c", "org2")).toBe(1);
  expect(await repo.getCloudBuildQueuePosition("dep-c", "org1")).toBeNull();
  expect(await repo.getCloudBuildQueuePosition("missing", "org1")).toBeNull();
  await db
    .update(schema.deployment)
    .set({ meta: { cloudBuildRequested: true, cloudBuildRequestedAt: 1600000000 } })
    .where(eq(schema.deployment.id, "dep-b"));
  expect(await repo.getCloudBuildQueuePosition("dep-b", "org1")).toBe(1);
  await repo.claimBuildExecution({
    deploymentId: "dep-b",
    buildSessionId: "session-b",
    projectId: "b",
    organizationId: "org1",
  });
  expect(await repo.getCloudBuildQueuePosition("dep-b", "org1")).toBeNull();
  expect(await repo.getCloudBuildQueuePosition("dep-a", "org1")).toBe(1);
  await db
    .update(schema.project)
    .set({ deletionInProgress: true })
    .where(eq(schema.project.id, "a"));
  expect(await repo.getCloudBuildQueuePosition("dep-a", "org1")).toBeNull();
});

const poisonHead = {
  deploymentId: "dep-a",
  buildSessionId: "session-a",
  projectId: "a",
  organizationId: "org1",
  errorMessage: "Unsupported build configuration",
  errorCode: "INVALID_BUILD_CONFIGURATION",
};

it("fails an unclaimed poison head atomically and prevents a later kickoff", async () => {
  await repo.requestCloudBuild("dep-a", "org1");
  expect(await repo.failUnclaimedCloudBuild(poisonHead)).toBe(true);
  expect(await repo.findById("dep-a")).toMatchObject({
    status: "failed",
    errorMessage: poisonHead.errorMessage,
    errorCode: poisonHead.errorCode,
    meta: { marker: "keep", cloudBuildRequested: true },
  });
  expect(await repo.findBuildSession("session-a")).toMatchObject({
    status: "failed",
    startedAt: null,
    finishedAt: expect.any(Date),
    durationMs: 0,
  });
  const session = await repo.findBuildSession("session-a");
  expect(await repo.failUnclaimedCloudBuild(poisonHead)).toBe(false);
  expect(await repo.findBuildSession("session-a")).toEqual(session);
  expect(await repo.claimBuildExecution(poisonHead)).toBe("state_changed");
  expect(await repo.listRequestedCloudBuilds()).toEqual([]);
});

it("rejects stale or mismatched poison-head failures without changing either record", async () => {
  expect(await repo.failUnclaimedCloudBuild(poisonHead)).toBe(false); // Untouched draft.
  await repo.requestCloudBuild("dep-a", "org1");
  const session = await repo.findBuildSession("session-a");
  const dep = await repo.findById("dep-a");
  for (const change of [
    { organizationId: "org2" },
    { projectId: "b" },
    { buildSessionId: "session-b" },
  ]) {
    expect(await repo.failUnclaimedCloudBuild({ ...poisonHead, ...change })).toBe(false);
    expect(await repo.findBuildSession("session-a")).toEqual(session);
    expect(await repo.findById("dep-a")).toEqual(dep);
  }
  for (const status of ["cancelled", "ready", "deploying"]) {
    await db.update(schema.deployment).set({ status }).where(eq(schema.deployment.id, "dep-a"));
    expect(await repo.failUnclaimedCloudBuild(poisonHead)).toBe(false);
    expect((await repo.findById("dep-a"))?.status).toBe(status);
    expect(await repo.findBuildSession("session-a")).toEqual(session);
  }
});

it("never fails or acknowledges a worker that acquired the execution lease", async () => {
  await repo.requestCloudBuild("dep-a", "org1");
  expect(await repo.claimBuildExecution(poisonHead)).toBe("claimed");
  const session = await repo.findBuildSession("session-a");
  expect(await repo.failUnclaimedCloudBuild(poisonHead)).toBe(false);
  expect((await repo.findById("dep-a"))?.status).toBe("building");
  expect(await repo.findBuildSession("session-a")).toEqual(session);
  expect(await repo.countActiveCloudBuilds("w1", "org1")).toBe(1);
});

const reservedClaim = {
  deploymentId: "dep-a",
  buildSessionId: "session-a",
  projectId: "a",
  organizationId: "org1",
  cloudBuildReservation: { workspaceId: "w1", resources: { cpuCores: 1, memoryMb: 1024 } },
};

it("claims the worker and reserves Cloud resources together, exactly once", async () => {
  expect(await repo.claimBuildExecution(reservedClaim)).toBe("claimed");
  expect((await repo.findById("dep-a"))?.status).toBe("building");
  expect(await repo.findBuildSession("session-a")).toMatchObject({
    startedAt: expect.any(Date),
    finishedAt: null,
  });
  const activities = createCloudBuildActivityRepo(db);
  expect(await activities.listReservations("w1", "org1")).toMatchObject([
    {
      deploymentId: "dep-a",
      buildSessionId: "session-a",
      projectId: "a",
      workspaceId: "w1",
      organizationId: "org1",
      resources: { cpuCores: 1, memoryMb: 1024 },
      ownerToken: null,
      exclusivePreparation: false,
    },
  ]);
  expect(await repo.claimBuildExecution(reservedClaim)).toBe("state_changed");
  expect(await activities.listReservations("w1", "org1")).toHaveLength(1);
  expect(await repo.countActiveCloudBuilds("w1", "org1")).toBe(0);
  await db.update(schema.cloudBuildActivity).set({ slotReleasedAt: new Date() });
  expect(await activities.listReservations("w1", "org1")).toEqual([]);
  expect(await repo.countActiveCloudBuilds("w1", "org1")).toBe(0);
  await db.update(schema.cloudBuildActivity).set({ finishedAt: new Date() });
  expect(await repo.countActiveCloudBuilds("w1", "org1")).toBe(0);
  expect((await repo.findBuildSession("session-a"))?.finishedAt).toBeNull();
});

it("rolls back the worker claim when resource validation or workspace identity fails", async () => {
  for (const reservation of [
    { workspaceId: "w1", resources: { cpuCores: -1, memoryMb: 1024 } },
    { workspaceId: "w2", resources: null },
    { workspaceId: "missing", resources: null },
  ]) {
    await expect(
      repo.claimBuildExecution({
        ...reservedClaim,
        cloudBuildReservation: { ...reservation, exclusivePreparation: true },
      }),
    ).rejects.toThrow();
    expect((await repo.findById("dep-a"))?.status).toBe("queued");
    expect(await repo.findBuildSession("session-a")).toMatchObject({
      status: "queued",
      startedAt: null,
      finishedAt: null,
    });
    expect(await db.select().from(schema.cloudBuildActivity)).toEqual([]);
  }
  expect(
    await repo.claimBuildExecution({
      ...reservedClaim,
      cloudBuildReservation: { workspaceId: "w1", resources: null },
    }),
  ).toBe("claimed");
  expect(await createCloudBuildActivityRepo(db).listReservations("w1", "org1")).toMatchObject([
    { resources: null },
  ]);
});

it("never reserves capacity for an unavailable project or stale deployment/session", async () => {
  await db
    .update(schema.project)
    .set({ deletionInProgress: true })
    .where(eq(schema.project.id, "a"));
  expect(await repo.claimBuildExecution(reservedClaim)).toBe("project_unavailable");
  await db
    .update(schema.project)
    .set({ deletionInProgress: false })
    .where(eq(schema.project.id, "a"));
  expect(await repo.claimBuildExecution({ ...reservedClaim, buildSessionId: "session-b" })).toBe(
    "state_changed",
  );
  await db
    .update(schema.deployment)
    .set({ status: "cancelled" })
    .where(eq(schema.deployment.id, "dep-a"));
  expect(await repo.claimBuildExecution(reservedClaim)).toBe("state_changed");
  expect(await db.select().from(schema.cloudBuildActivity)).toEqual([]);
  expect((await repo.findBuildSession("session-a"))?.startedAt).toBeNull();
});

it("counts legacy leases alongside reservations without double-counting", async () => {
  await db.update(schema.project).set({ workspaceId: "w1" }).where(eq(schema.project.id, "b"));
  await repo.claimBuildExecution(reservedClaim);
  await repo.claimBuildExecution({
    deploymentId: "dep-b",
    buildSessionId: "session-b",
    projectId: "b",
    organizationId: "org1",
  });
  expect(await repo.countActiveCloudBuilds("w1", "org1")).toBe(1);
  expect(await createCloudBuildActivityRepo(db).listReservations("w1", "org1")).toHaveLength(1);
  await db
    .update(schema.deployment)
    .set({ status: "cancelled" })
    .where(eq(schema.deployment.id, "dep-b"));
  expect(await repo.countActiveCloudBuilds("w1", "org1")).toBe(1);
  await repo.acknowledgeBuildExecutionFinished("session-b");
  expect(await repo.countActiveCloudBuilds("w1", "org1")).toBe(0);
});

it("lists unfinished Cloud execution identities including terminal and deleting projects", async () => {
  await repo.claimBuildExecution(reservedClaim);
  await repo.claimBuildExecution({
    deploymentId: "dep-b",
    buildSessionId: "session-b",
    projectId: "b",
    organizationId: "org1",
  });
  await repo.claimBuildExecution({
    deploymentId: "dep-c",
    buildSessionId: "session-c",
    projectId: "c",
    organizationId: "org2",
  });
  await db.update(schema.project).set({ workspaceId: null }).where(eq(schema.project.id, "c"));
  await db
    .update(schema.project)
    .set({ deletionInProgress: true, deletedAt: new Date() })
    .where(eq(schema.project.id, "a"));
  await db
    .update(schema.deployment)
    .set({ status: "cancelled" })
    .where(eq(schema.deployment.id, "dep-a"));
  expect(await repo.listUnfinishedCloudBuildExecutions()).toEqual([
    {
      deploymentId: "dep-a",
      buildSessionId: "session-a",
      projectId: "a",
      organizationId: "org1",
      workspaceId: "w1",
    },
    {
      deploymentId: "dep-b",
      buildSessionId: "session-b",
      projectId: "b",
      organizationId: "org1",
      workspaceId: "w2",
    },
  ]);
  expect(await repo.listUnfinishedCloudBuildExecutions(1)).toHaveLength(1);
  await repo.acknowledgeBuildExecutionFinished("session-b");
  expect(await repo.listUnfinishedCloudBuildExecutions()).toHaveLength(1);
  expect(await repo.listUnfinishedCloudBuildExecutions(0)).toEqual([]);
});

it("freezes exclusive preparation with the claim and exposes it after slot release despite policy edits", async () => {
  await db.insert(schema.backupPolicy).values({
    id: "predeploy-policy",
    projectId: "a",
    destinationId: "test-destination",
    enabled: true,
    triggerOnPreDeploy: true,
  });
  const input = {
    ...reservedClaim,
    cloudBuildReservation: { ...reservedClaim.cloudBuildReservation, exclusivePreparation: true },
  };
  expect(await repo.claimBuildExecution(input)).toBe("claimed");
  const activities = createCloudBuildActivityRepo(db);
  expect(await activities.listActive("w1", "org1")).toMatchObject([
    {
      deploymentId: "dep-a",
      buildSessionId: "session-a",
      exclusivePreparation: true,
    },
  ]);
  expect(await repo.findBuildSession("session-a")).toMatchObject({
    startedAt: expect.any(Date),
    finishedAt: null,
  });
  await db
    .update(schema.backupPolicy)
    .set({ enabled: false, triggerOnPreDeploy: false })
    .where(eq(schema.backupPolicy.id, "predeploy-policy"));
  await db.insert(schema.cloudDockerWorkspace).values({
    ownerWorkspaceId: "w1",
    namespace: "test",
    provisionKey: "test",
    workspaceId: "test-vm",
    image: "test",
    resources: { cpuCores: 2, memoryMb: 4096, diskMb: 10000 },
    state: "ready",
  });
  const identity = {
    deploymentId: "dep-a",
    projectId: "a",
    workspaceId: "w1",
    organizationId: "org1",
  };
  await activities.claim(identity, "worker");
  await activities.releaseSlot(identity, "worker");
  // A late kickoff using the edited policy cannot replace the admission snapshot.
  expect(await repo.claimBuildExecution(reservedClaim)).toBe("state_changed");
  const restarted = createCloudBuildActivityRepo(db);
  expect(await restarted.listReservations("w1", "org1")).toEqual([]);
  expect(await restarted.listActive("w1", "org1")).toMatchObject([
    {
      deploymentId: "dep-a",
      exclusivePreparation: true,
      slotReleasedAt: expect.any(Date),
      finishedAt: null,
    },
  ]);
});

const deferredClaim = {
  deploymentId: "dep-a",
  buildSessionId: "session-a",
  projectId: "a",
  workspaceId: "w1",
  organizationId: "org1",
};
async function prepareDeferral() {
  await repo.requestCloudBuild("dep-a", "org1");
  expect(await repo.claimBuildExecution(reservedClaim)).toBe("claimed");
}
async function deferralState() {
  return {
    deployment: await repo.findById("dep-a"),
    session: await repo.findBuildSession("session-a"),
    activity: await createCloudBuildActivityRepo(db).find(deferredClaim),
  };
}

it("defers only the untouched reservation, preserves FIFO/logs and can reserve afresh", async () => {
  await prepareDeferral();
  const logs = [{ message: "Preparation completed", level: "info" }];
  await repo.updateBuildSession("session-a", { logs });
  const before = await deferralState();
  const maintenance = {
    id: "manual",
    controllerId: "saas",
    scope: "server",
    startedAt: new Date().toISOString(),
  };
  await db
    .update(schema.cloudWorkspace)
    .set({ activity: maintenance })
    .where(eq(schema.cloudWorkspace.id, "w1"));
  expect(await repo.deferUnactivatedCloudBuild(deferredClaim)).toBe(true);
  expect((await repo.findById("dep-a"))?.meta).toEqual({
    ...(before.deployment!.meta as Record<string, unknown>),
    cloudBuildQueueReason: "server",
    cloudBuildQueue: {
      reason: "server",
      limit: null,
      message: "Waiting for the managed server to become available.",
    },
  });
  expect((await repo.findById("dep-a"))?.createdAt).toEqual(before.deployment?.createdAt);
  expect((await repo.findById("dep-a"))?.status).toBe("queued");
  expect(await repo.findBuildSession("session-a")).toMatchObject({
    status: "queued",
    startedAt: null,
    finishedAt: null,
    logs,
  });
  expect(await createCloudBuildActivityRepo(db).find(deferredClaim)).toBeUndefined();
  expect(
    (await db.select().from(schema.cloudWorkspace).where(eq(schema.cloudWorkspace.id, "w1")))[0]
      .activity,
  ).toEqual(maintenance);
  expect(await repo.getCloudBuildQueuePosition("dep-a", "org1")).toBe(1);
  expect(await repo.deferUnactivatedCloudBuild(deferredClaim)).toBe(false);
  await expect(repo.claimBuildExecution(reservedClaim)).rejects.toMatchObject({
    code: "CLOUD_WORKSPACE_ACTIVITY_BUSY",
  });
  expect((await repo.findById("dep-a"))?.status).toBe("queued");
  expect((await repo.findBuildSession("session-a"))?.startedAt).toBeNull();
  await db
    .update(schema.cloudWorkspace)
    .set({ activity: null })
    .where(eq(schema.cloudWorkspace.id, "w1"));
  expect(
    await repo.claimBuildExecution({
      ...reservedClaim,
      cloudBuildReservation: {
        workspaceId: "w1",
        resources: { cpuCores: 2, memoryMb: 2048 },
        exclusivePreparation: true,
      },
    }),
  ).toBe("claimed");
  expect(await createCloudBuildActivityRepo(db).find(deferredClaim)).toMatchObject({
    resources: { cpuCores: 2, memoryMb: 2048 },
    exclusivePreparation: true,
  });
});

it("never defers a cancelled worker or changes its cancellation record", async () => {
  await prepareDeferral();
  expect(await repo.cancelInFlight("dep-a")).toBe(true);
  const before = await deferralState();
  expect(await repo.deferUnactivatedCloudBuild(deferredClaim)).toBe(false);
  expect(await deferralState()).toEqual(before);
});

it("refuses activated, command-bearing, released or completed reservations without mutations", async () => {
  await prepareDeferral();
  const activity = (await deferralState()).activity!;
  for (const state of [
    { ownerToken: "worker" },
    { startedAt: new Date() },
    { providerWorkspaceId: "vm" },
    { commands: [{ workspaceId: "vm", marker: "running-command" }] },
    { slotReleasedAt: new Date() },
    { finishedAt: new Date() },
  ]) {
    await db
      .update(schema.cloudBuildActivity)
      .set({ ...activity, ...state })
      .where(eq(schema.cloudBuildActivity.deploymentId, "dep-a"));
    const before = await deferralState();
    expect(await repo.deferUnactivatedCloudBuild(deferredClaim)).toBe(false);
    expect(await deferralState()).toEqual(before);
  }
});

it("refuses wrong-tenant/project/workspace/session deferrals without mutations", async () => {
  await prepareDeferral();
  const before = await deferralState();
  for (const mismatch of [
    { organizationId: "org2" },
    { projectId: "b" },
    { workspaceId: "w2" },
    { buildSessionId: "session-b" },
    { deploymentId: "dep-b" },
  ]) {
    expect(await repo.deferUnactivatedCloudBuild({ ...deferredClaim, ...mismatch })).toBe(false);
    expect(await deferralState()).toEqual(before);
  }
});

it("rolls back the reservation deletion and session reset if requeueing fails", async () => {
  await prepareDeferral();
  const before = await deferralState();
  await client.exec(`CREATE FUNCTION reject_test_requeue() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status = 'queued' THEN RAISE EXCEPTION 'test requeue failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_test_requeue BEFORE UPDATE ON deployment FOR EACH ROW EXECUTE FUNCTION reject_test_requeue();
    ALTER TABLE deployment ENABLE ALWAYS TRIGGER reject_test_requeue;`);
  try {
    await expect(repo.deferUnactivatedCloudBuild(deferredClaim)).rejects.toThrow();
    expect(await deferralState()).toEqual(before);
  } finally {
    await client.exec(
      "DROP TRIGGER reject_test_requeue ON deployment; DROP FUNCTION reject_test_requeue();",
    );
  }
});
