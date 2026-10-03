import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createServerClusterRepo } from "./server-cluster.repo";
import { createComputeClusterRepo } from "./compute-cluster.repo";
import { createClusterRuntimeRepo } from "./cluster-runtime.repo";
import { clusterRuntimePlanFixture } from "../../../contracts/test/cluster-runtime-fixtures";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const networks = createServerClusterRepo(db);
const clusters = createComputeClusterRepo(db);
const runtimes = createClusterRuntimeRepo(db);
let cluster: Awaited<ReturnType<typeof clusters.get>>;
const plan = () => ({ ...clusterRuntimePlanFixture(), networkId: cluster.networkId });
const start = () =>
  runtimes.start("org", cluster.id, cluster.revision, "request-123456789", plan());
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}, 30_000);
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.delete(schema.projectGroup);
  await db.delete(schema.clusterRuntime);
  await db.delete(schema.computeCluster);
  await db.delete(schema.serverCluster);
  await db.delete(schema.project);
  await db.delete(schema.servers);
  await db.delete(schema.cloudWorkspace);
  await db.delete(schema.organization);
  await db.insert(schema.organization).values([
    { id: "org", name: "Org" },
    { id: "other", name: "Other" },
  ]);
  await db
    .insert(schema.servers)
    .values(["a", "b", "c"].map((id) => ({ id, organizationId: "org", sshHost: id })));
  const network = await networks.create(
    "org",
    {
      name: "Private",
      network: { mode: "native", cidrs: ["10.20.0.0/24"], mtu: 1400, probePort: 51821 },
      members: clusterRuntimePlanFixture().hosts.map((host) => ({
        serverId: host.serverId,
        privateIp: host.privateIp,
        providerId: "custom" as const,
      })),
    },
    "network",
    "hash",
  );
  cluster = await clusters.create(
    "org",
    { name: "Production", networkId: network.id, serverIds: ["a", "b", "c"] },
    "cluster",
    "hash",
  );
});

async function readyRuntime() {
  const { row } = await start();
  const ready = plan();
  ready.clusterUid = "kubernetes-cluster";
  for (const host of ready.hosts) {
    host.ready = true;
    host.installed = true;
    for (const step of host.steps) step.status = "completed";
  }
  await runtimes.finish(row.id, row.generation, ready, "setup", null);
  return (await runtimes.get("org", cluster.id))!;
}

async function createProject(organizationId = "org") {
  await db
    .insert(schema.projectGroup)
    .values({ id: "group", name: "API", slug: "api", organizationId });
  const [project] = await db
    .insert(schema.project)
    .values({
      id: "project",
      groupId: "group",
      name: "API",
      slug: "api",
      organizationId,
      serverId: "a",
    })
    .returning();
  return project!;
}

describe("project cluster binding", () => {
  it("projects scaling readiness separately from the network without exposing installation details", async () => {
    expect((await clusters.get("org", cluster.id)).scaling).toBeNull();
    expect((await clusters.list("org"))[0]?.scaling).toBeNull();
    const runtime = await readyRuntime();
    const expected = { status: "ready", verifiedAt: runtime.verifiedAt };
    expect((await clusters.get("org", cluster.id)).scaling).toEqual(expected);
    expect((await clusters.list("org"))[0]?.scaling).toEqual(expected);
    expect(await clusters.list("other")).toEqual([]);
    await db
      .update(schema.clusterRuntime)
      .set({ status: "failed" })
      .where(eq(schema.clusterRuntime.id, runtime.id));
    expect((await clusters.get("org", cluster.id)).scaling?.status).toBe("failed");
  });
  it("moves intent off the Docker host, rejects stale saves, and blocks runtime removal", async () => {
    const ready = await readyRuntime();
    const project = await createProject();
    const updated = await runtimes.bindProject(
      "org",
      project.id,
      cluster.id,
      { replicas: 3, imageRepository: "ghcr.io/team/api" },
      project.updatedAt.toISOString(),
    );
    expect(updated).toMatchObject({
      clusterId: cluster.id,
      serverId: null,
      clusterConfig: { replicas: 3 },
      runtimeMode: "docker",
    });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(project.updatedAt.getTime());
    await expect(
      runtimes.bindProject("org", project.id, null, null, project.updatedAt.toISOString()),
    ).rejects.toThrow("settings changed");
    await expect(runtimes.change("org", cluster.id, ready.sequence, "remove")).rejects.toThrow(
      "Projects still target",
    );
    const detached = await runtimes.bindProject(
      "org",
      project.id,
      null,
      null,
      updated.updatedAt.toISOString(),
    );
    expect(detached.clusterId).toBeNull();
    expect(detached.clusterConfig).toBeNull();
    expect((await runtimes.change("org", cluster.id, ready.sequence, "remove")).started).toBe(true);
  });

  it("refuses an unfinished runtime and never rebinds another organization's project", async () => {
    await start();
    const project = await createProject("other");
    await expect(
      runtimes.bindProject(
        "org",
        project.id,
        cluster.id,
        { replicas: 2 },
        project.updatedAt.toISOString(),
      ),
    ).rejects.toThrow("Finish setting up");
    const ready = plan();
    for (const host of ready.hosts) {
      host.ready = true;
      host.installed = true;
      for (const step of host.steps) step.status = "completed";
    }
    const row = (await runtimes.get("org", cluster.id))!;
    await runtimes.finish(row.id, row.generation, ready, "setup", null);
    await expect(
      runtimes.bindProject(
        "org",
        project.id,
        cluster.id,
        { replicas: 2 },
        project.updatedAt.toISOString(),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await db.select().from(schema.project))[0]!.clusterId).toBeNull();
  });

  it("rejects cloud bindings and invalid counts before changing project intent", async () => {
    await readyRuntime();
    const project = await createProject();
    await expect(
      runtimes.bindProject(
        "org",
        project.id,
        cluster.id,
        { replicas: 0 },
        project.updatedAt.toISOString(),
      ),
    ).rejects.toThrow("between 1 and 100");
    await db.insert(schema.cloudWorkspace).values({ id: "cloud-workspace", name: "Managed", organizationId: "org" });
    await db.insert(schema.servers).values({ id: "cloud-server", name: "Managed", organizationId: "org", workspaceId: "cloud-workspace" });
    await db
      .update(schema.project)
      .set({ serverId: "cloud-server" })
      .where(eq(schema.project.id, project.id));
    await expect(
      runtimes.bindProject(
        "org",
        project.id,
        cluster.id,
        { replicas: 2 },
        project.updatedAt.toISOString(),
      ),
    ).rejects.toThrow("Cloud projects");
  });
});

describe("durable cluster runtime", () => {
  it("collapses repeated starts into the same operation and scopes reads to the organization", async () => {
    const results = await Promise.all([start(), start()]);
    expect(results.map((result) => result.started).sort()).toEqual([false, true]);
    expect(results[0]!.row.id).toBe(results[1]!.row.id);
    expect(await runtimes.get("other", cluster.id)).toBeNull();
    await expect(
      runtimes.start("other", cluster.id, 1, "request-123456789", plan()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("fences the old worker after interruption and requires an explicit retry", async () => {
    const { row } = await start();
    await runtimes.interrupt(row.id, row.generation, "Controller stopped");
    const stopped = (await runtimes.get("org", cluster.id))!;
    expect(stopped.status).toBe("interrupted");
    expect((await start()).started).toBe(false);
    const retried = await runtimes.change("org", cluster.id, stopped.sequence, "retry");
    expect(retried.row.generation).toBe(2);
    expect(await runtimes.heartbeat(row.id, row.generation)).toBe(false);
    await expect(runtimes.progress(row.id, row.generation, plan())).rejects.toMatchObject({
      code: "CLUSTER_RUNTIME_CONFLICT",
    });
  });
  it("expires abandoned leases but keeps another controller's live run", async () => {
    const { row } = await start();
    expect(await runtimes.recoverInterrupted(false)).toHaveLength(0);
    await db
      .update(schema.clusterRuntime)
      .set({ leaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(schema.clusterRuntime.id, row.id));
    expect((await runtimes.get("org", cluster.id))!.status).toBe("interrupted");
  });
  it("requires every prerequisite and real readiness before completion", async () => {
    const { row } = await start();
    const value = plan();
    for (const host of value.hosts) {
      host.ready = true;
      host.steps = [];
    }
    await expect(runtimes.finish(row.id, 1, value, "setup", null)).rejects.toThrow("Every server");
    const ready = plan();
    for (const host of ready.hosts) {
      host.ready = true;
      host.installed = true;
      for (const step of host.steps) step.status = "completed";
    }
    expect(await runtimes.finish(row.id, 1, ready, "setup", null)).toBe(true);
    expect((await runtimes.get("org", cluster.id))!.status).toBe("ready");
  });
  it("keeps cluster and network ownership after failure until verified removal", async () => {
    const { row } = await start();
    await runtimes.finish(row.id, 1, plan(), "setup", "Download failed");
    await expect(clusters.remove("org", cluster.id, cluster.revision)).rejects.toThrow(
      "Remove the cluster runtime first",
    );
    await expect(
      clusters.update("org", cluster.id, 1, {
        name: "Changed",
        networkId: cluster.networkId,
        serverIds: ["a"],
      }),
    ).rejects.toThrow("runtime");
    await expect(networks.remove("org", cluster.networkId, 1)).rejects.toMatchObject({
      code: "NETWORK_IN_USE",
    });
    const failed = (await runtimes.get("org", cluster.id))!;
    const removing = await runtimes.change("org", cluster.id, failed.sequence, "remove");
    const cleaned = plan();
    for (const host of cleaned.hosts)
      host.steps = [
        { id: "remove", status: "completed", message: null, startedAt: null, finishedAt: null },
      ];
    await runtimes.finish(row.id, removing.row.generation, cleaned, "remove", null);
    await clusters.remove("org", cluster.id, cluster.revision);
    expect((await networks.get("org", cluster.networkId)).members).toHaveLength(3);
  });
});
