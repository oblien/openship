import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq, sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { assertCloudWorkspacePlacement, createCloudWorkspaceRepo } from "./cloud-workspace.repo";
import { createCloudDockerWorkspaceRepo } from "./cloud-docker-workspace.repo";
import { createServerRepo } from "./server.repo";
import { createDockerMigrationRunRepo } from "./docker-migration.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const workspaces = createCloudWorkspaceRepo(db);
const hosts = createCloudDockerWorkspaceRepo(db);
const resources = { cpuCores: 2, memoryMb: 8192, diskMb: 25600 };
const intent = (
  kind: schema.CloudWorkspaceOperation["kind"],
  id = `operation-${kind}`,
): schema.CloudWorkspaceOperation => ({
  id,
  kind,
  status: "queued",
  requestedAt: new Date().toISOString(),
  attempts: 0,
  nextAttemptAt: null,
  error: null,
  logs: ["Queued"],
});
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
});
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await db.delete(schema.dockerMigrationRun);
  await db.delete(schema.cloudDockerWorkspace);
  await db.delete(schema.project);
  await db.delete(schema.servers);
  await db.delete(schema.cloudServerDeletion);
  await db.delete(schema.cloudWorkspace);
  await db.delete(schema.organization);
  await db.insert(schema.organization).values([
    { id: "org-a", name: "A" },
    { id: "org-b", name: "B" },
  ]);
  await db
    .insert(schema.projectGroup)
    .values({ id: "group", organizationId: "org-a", name: "Apps", slug: "apps" });
});

describe("migration placement and server lifecycle", () => {
  it.each([
    ["managed", "managed"], ["ssh", "managed"], ["managed", "ssh"],
  ])("saves and restores %s → %s placement and storage atomically", async (sourceKind, targetKind) => {
    const inventory = createServerRepo(db);
    const endpoint = async (kind: string) => kind === "managed"
      ? (await inventory.findByWorkspace((await createWorkspace()).id, "org-a"))!
      : await inventory.create({ organizationId: "org-a", sshHost: "203.0.113.1" });
    const a = await endpoint(sourceKind), b = await endpoint(targetKind);
    await db.insert(schema.project).values({ id: "moved", organizationId: "org-a", groupId: "group",
      name: "Moved", slug: "moved", serverId: a.id });
    await db.insert(schema.service).values({ id: "svc", projectId: "moved", name: "db", image: "postgres:17",
      volumes: ["old-data:/data"], namespaceVolumes: false });
    const runs = createDockerMigrationRunRepo(db);
    await runs.create({ id: "move", organizationId: "org-a", projectId: "moved", projectName: "moved",
      mode: "project_move", sourceServerId: a.id, targetServerId: b.id, status: "adopting" });
    if (a.workspaceId) {
      // A live migration is not a blanket bypass for ordinary project writes.
      await expect(db.update(schema.project).set({ serverId: b.id, workspaceId: b.workspaceId })
        .where(eq(schema.project.id, "moved"))).rejects.toThrow();
    }
    await runs.placeProject("move", "org-a", b.id);
    expect(await db.query.project.findFirst({ where: eq(schema.project.id, "moved") }))
      .toMatchObject({ serverId: b.id, workspaceId: b.workspaceId });
    if (b.workspaceId) {
      // The migration's transaction-local intent must not escape to the next write.
      await expect(db.update(schema.project).set({ serverId: a.id, workspaceId: a.workspaceId })
        .where(eq(schema.project.id, "moved"))).rejects.toThrow();
    }
    await db.update(schema.service).set({ volumes: ["new-data:/data"], namespaceVolumes: true }).where(eq(schema.service.id, "svc"));
    await runs.restoreProject("move", "org-a");
    expect(await db.query.project.findFirst({ where: eq(schema.project.id, "moved") }))
      .toMatchObject({ serverId: a.id, workspaceId: a.workspaceId });
    expect(await db.query.service.findFirst({ where: eq(schema.service.id, "svc") }))
      .toMatchObject({ volumes: ["old-data:/data"], namespaceVolumes: false });
    await runs.transition("move", "rolled_back");
    await expect(runs.placeProject("move", "org-a", b.id)).rejects.toThrow("no longer placing");
    await expect(runs.restoreProject("move", "org-a")).rejects.toThrow("no longer restore");
  });

  it("does not let an explicit migration intent reassign ownership or move an unrelated project", async () => {
    const source = await createWorkspace(), target = await createWorkspace();
    const inventory = createServerRepo(db);
    const a = (await inventory.findByWorkspace(source.id, "org-a"))!;
    const b = (await inventory.findByWorkspace(target.id, "org-a"))!;
    await addProject("subject", source.id);
    await addProject("unrelated", source.id);
    const runs = createDockerMigrationRunRepo(db);
    await runs.create({ id: "move", organizationId: "org-a", projectId: "subject", projectName: "Subject",
      mode: "project_move", sourceServerId: a.id, targetServerId: b.id, status: "adopting" });
    await runs.placeProject("move", "org-a", b.id);
    await expect(runs.placeProject("move", "org-b", b.id)).rejects.toThrow("unavailable");
    for (const patch of [
      { id: "unrelated", serverId: b.id, workspaceId: target.id, organizationId: "org-a" },
      { id: "subject", serverId: a.id, workspaceId: source.id, organizationId: "org-b" },
    ]) {
      await expect(db.transaction(async tx => {
        await tx.execute(sql`select set_config('openship.migration_id', 'move', true)`);
        await tx.update(schema.project).set(patch).where(eq(schema.project.id, patch.id));
      })).rejects.toThrow();
    }
    expect(await db.query.project.findFirst({ where: eq(schema.project.id, "subject") }))
      .toMatchObject({ serverId: b.id, workspaceId: target.id, organizationId: "org-a" });
  });

  it.each(["resize", "delete"] as const)("blocks %s while migration or temporary SSH recovery still owns a server", async kind => {
    const owner = await createWorkspace();
    const server = (await createServerRepo(db).findByWorkspace(owner.id, "org-a"))!;
    const runs = createDockerMigrationRunRepo(db);
    await runs.create({ id: "active-move", organizationId: "org-a", projectName: "app",
      sourceServerId: server.id, targetServerId: server.id, status: "moving_data" });
    await expect(workspaces.requestOperation(owner.id, "org-a", intent(kind)))
      .rejects.toMatchObject({ code: "CLOUD_WORKSPACE_MIGRATION_ACTIVE" });
    await runs.transition("active-move", "rolled_back");
    await runs.updateRecovery("active-move", { transferRunTag: "unfinished-trust" });
    expect(await runs.findActiveForServer(server.id)).toHaveLength(1);
    await expect(workspaces.requestOperation(owner.id, "org-a", intent(kind)))
      .rejects.toMatchObject({ code: "CLOUD_WORKSPACE_MIGRATION_ACTIVE" });
    await runs.updateRecovery("active-move", { transferRunTag: null });
    expect(await runs.findActiveForServer(server.id)).toHaveLength(0);
  });

  it("does not expose migration connections as normal deployment servers", async () => {
    const servers = createServerRepo(db);
    const row = await servers.create({ organizationId: "org-a", purpose: "migration_source",
      sshHost: "203.0.113.1", sshAuthMethod: "password", sshPassword: "encrypted-password", sshHostKey: "public-key" });
    expect((await servers.listMigrationSources("org-a")).map(server => server.id)).toEqual([row.id]);
    expect(await servers.listMigrationSources("org-b")).toEqual([]);
    expect(await servers.listByOrganization("org-a")).toEqual([]);
    await expect(db.insert(schema.project).values({ id: "external-project", organizationId: "org-a", groupId: "group",
      name: "Invalid destination", slug: "external-project", serverId: row.id })).rejects.toThrow();
  });

  it.each([
    { isLocal: true }, { organizationId: null }, { sshHostKey: null },
    { sshKeyPath: "/api/private-key" }, { sshArgs: "ProxyCommand=local" },
    { sshJumpHost: "internal" }, { sshTransport: "cloudflare" as const },
    { sshAuthMethod: "agent", sshPassword: null },
  ])("rejects unsafe stored migration-source settings: %j", async patch => {
    await expect(db.insert(schema.servers).values({
      id: "unsafe", organizationId: "org-a", purpose: "migration_source", sshHost: "203.0.113.1",
      sshAuthMethod: "password", sshPassword: "encrypted-password", sshHostKey: "public-key", ...patch,
    })).rejects.toThrow();
  });
});
async function createWorkspace() {
  const workspace = await workspaces.create({ organizationId: "org-a", name: "Production" });
  return workspaces.setNamespace(workspace.id, "org-a", `ns-${workspace.id}`);
}
async function addProject(id: string, workspaceId: string) {
  const server = await createServerRepo(db).findByWorkspace(workspaceId, "org-a");
  return db.transaction(async (tx) => {
    const row = {
      id,
      workspaceId,
      serverId: server!.id,
      organizationId: "org-a",
      groupId: "group",
      name: id,
      runtimeMode: "docker",
      slug: id,
      environmentSlug: id,
    };
    await assertCloudWorkspacePlacement(tx, row);
    await tx.insert(schema.project).values(row);
  });
}
describe("subscription workspace ownership", () => {
  it("registers one execution server for each independent managed subscription", async () => {
    const shared = await createWorkspace();
    const dedicated = await createWorkspace();
    for (const owner of [shared, dedicated]) {
      const server = await createServerRepo(db).findByWorkspace(owner.id, "org-a");
      expect(server).toMatchObject({ organizationId: "org-a", workspaceId: owner.id, sshHost: null, isLocal: false });
      await expect(createServerRepo(db).delete(server!.id)).rejects.toMatchObject({ code: "MANAGED_SERVER_LIFECYCLE_REQUIRED" });
    }
    expect(await db.select().from(schema.servers)).toHaveLength(2);
  });
  it("renames the workspace and its execution host together within the owning organization", async () => {
    const workspace = await createWorkspace();
    const servers = createServerRepo(db);
    const server = (await servers.findByWorkspace(workspace.id, "org-a"))!;
    expect(await workspaces.rename(workspace.id, "org-b", "Wrong owner")).toBeUndefined();
    expect((await servers.get(server.id))?.name).toBe("Production");
    await workspaces.rename(workspace.id, "org-a", "Customer apps");
    expect((await workspaces.findById(workspace.id))?.name).toBe("Customer apps");
    expect((await servers.get(server.id))?.name).toBe("Customer apps");
    expect(await servers.listByOrganization("org-a")).toEqual([]);
  });
  it("derives the project billing owner from its server and rejects conflicting owners", async () => {
    const first = await createWorkspace();
    const second = await createWorkspace();
    const server = (await createServerRepo(db).findByWorkspace(first.id, "org-a"))!;
    const [created] = await db.insert(schema.project).values({
      id: "derived", organizationId: "org-a", groupId: "group", name: "Derived", slug: "derived", serverId: server.id,
    }).returning();
    expect(created.workspaceId).toBe(first.id);
    await expect(db.update(schema.project).set({ workspaceId: second.id }).where(eq(schema.project.id, "derived"))).rejects.toThrow();
    await expect(db.update(schema.project).set({ serverId: null }).where(eq(schema.project.id, "derived"))).rejects.toThrow();
    await expect(db.update(schema.servers).set({ workspaceId: second.id }).where(eq(schema.servers.id, server.id))).rejects.toThrow();
    await expect(db.insert(schema.project).values({
      id: "foreign-server", organizationId: "org-b", groupId: "group", name: "Foreign", slug: "foreign-server", serverId: server.id,
    })).rejects.toThrow();
  });
  it("concurrent projects share one durable host and deleting either preserves it", async () => {
    const workspace = await createWorkspace();
    await Promise.all([addProject("a", workspace.id), addProject("b", workspace.id)]);
    const [a, b] = await Promise.all(
      ["a", "b"].map((projectId) =>
        hosts.reserve(
          { ownerWorkspaceId: workspace.id, namespace: workspace.namespace!, image: "docker", resources },
          "org-a",
        ),
      ),
    );
    expect(a.id).toBe(b.id);
    expect(a.provisionKey).toBe(b.provisionKey);
    expect(a.ownerWorkspaceId).toBe(workspace.id);
    await hosts.attach("a", "org-a", workspace.namespace!, "vm-shared");
    expect((await hosts.find("b", "org-a"))?.workspaceId).toBe("vm-shared");
    expect(
      (await db.query.project.findFirst({ where: eq(schema.project.id, "b") }))?.workspaceId,
    ).toBe(workspace.id);
    await db.delete(schema.project).where(eq(schema.project.id, "a"));
    expect((await hosts.find("b", "org-a"))?.workspaceId).toBe("vm-shared");
    await db.delete(schema.project).where(eq(schema.project.id, "b"));
    expect((await hosts.find({ ownerWorkspaceId: workspace.id }, "org-a"))?.workspaceId).toBe(
      "vm-shared",
    );
    expect(await workspaces.findByIdInOrganization(workspace.id, "org-a")).toBeDefined();
  });
  it("rejects cross-organization membership at the database boundary and host access", async () => {
    const workspace = await createWorkspace();
    await expect(
      db.insert(schema.project).values({
        id: "foreign",
        organizationId: "org-b",
        groupId: "group",
        name: "Foreign",
        slug: "foreign",
        workspaceId: workspace.id,
      }),
    ).rejects.toThrow();
    await expect(
      hosts.reserve(
        {
          ownerWorkspaceId: workspace.id,
          namespace: workspace.namespace!,
          image: "docker",
          resources,
        },
        "org-b",
      ),
    ).rejects.toThrow();
    expect(await hosts.find({ ownerWorkspaceId: workspace.id }, "org-b")).toBeUndefined();
    await expect(workspaces.setNamespace(workspace.id, "org-b", "stolen")).rejects.toThrow();
  });
  it("allows Docker and bare projects to share a server without changing its identity", async () => {
    const workspace = await createWorkspace();
    await Promise.all([addProject("docker-app", workspace.id), addProject("bare-app", workspace.id)]);
    await db.update(schema.project).set({ runtimeMode: "bare" }).where(eq(schema.project.id, "bare-app"));
    const projects = await db.select().from(schema.project);
    expect(projects).toHaveLength(2);
    expect(new Set(projects.map(project => project.serverId)).size).toBe(1);
    expect(new Set(projects.map(project => project.runtimeMode))).toEqual(new Set(["docker", "bare"]));
  });
  it("keeps subscriptions independently scoped within the same organization", async () => {
    const first = await createWorkspace();
    const second = await createWorkspace();
    await workspaces.setBillingEntitlement(first.id, "org-a", first.namespace!, {
      planTierId: "pro",
      subscriptionStatus: "active",
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });
    expect((await workspaces.findByIdInOrganization(second.id, "org-a"))?.planTierId).toBe("free");
    await expect(
      workspaces.setBillingEntitlement(second.id, "org-a", first.namespace!, {
        planTierId: "pro",
        subscriptionStatus: "active",
        currentPeriodStart: null,
        currentPeriodEnd: null,
      }),
    ).rejects.toThrow();
    await expect(workspaces.setNamespace(second.id, "org-a", first.namespace!)).rejects.toThrow();
  });
  it("can reserve an empty paid workspace before its first project", async () => {
    const workspace = await createWorkspace();
    const owner = { ownerWorkspaceId: workspace.id };
    await hosts.reserve(
      { ...owner, namespace: workspace.namespace!, image: "docker", resources },
      "org-a",
    );
    await hosts.attach(owner, "org-a", workspace.namespace!, "vm-first");
    await addProject("later", workspace.id);
    expect((await hosts.find("later", "org-a"))?.workspaceId).toBe("vm-first");
  });
  it("keeps completed operation logs and treats an HTTP replay as the same result", async () => {
    const workspace = await createWorkspace();
    const op = intent("ensure");
    await workspaces.requestOperation(workspace.id, "org-a", op);
    await workspaces.updateOperation(
      workspace.id,
      { ...op, status: "succeeded", logs: ["Ready"] },
      op.id,
    );
    expect((await workspaces.requestOperation(workspace.id, "org-a", op)).operation).toMatchObject({
      status: "succeeded",
      logs: ["Ready"],
    });
    expect(await workspaces.listPendingOperations()).toEqual([]);
    await expect(
      workspaces.requestOperation(workspace.id, "org-a", { ...op, kind: "delete" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });
  it("does not discard a failed resize's running-container checkpoint", async () => {
    const workspace = await createWorkspace();
    await addProject("existing", workspace.id);
    const op = { ...intent("resize"), resources, restartProjectIds: ["existing"] };
    await workspaces.requestOperation(workspace.id, "org-a", op);
    await workspaces.updateOperation(
      workspace.id,
      { ...op, status: "failed", restartWorkloads: { wasRunning: true, containers: ["012345abcdef"], processes: [] } },
      op.id,
    );
    await expect(
      workspaces.requestOperation(workspace.id, "org-a", intent("ensure")),
    ).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_BUSY" });
    await expect(addProject("new", workspace.id)).rejects.toMatchObject({
      code: "CLOUD_WORKSPACE_BUSY",
    });
    const failed = (await workspaces.findById(workspace.id))!.operation!;
    const retried = await workspaces.requestOperation(workspace.id, "org-a", {
      ...failed,
      status: "queued",
    });
    expect(retried.operation?.restartWorkloads?.containers).toEqual(["012345abcdef"]);
    await workspaces.updateOperation(
      workspace.id,
      { ...retried.operation!, status: "succeeded" },
      op.id,
    );
    await expect(addProject("new", workspace.id)).resolves.toBeUndefined();
  });
  it("allows a failed preflight to be reviewed again before a resize mutates the host", async () => {
    const workspace = await createWorkspace();
    const op = { ...intent("resize"), resources, restartProjectIds: [] };
    await workspaces.requestOperation(workspace.id, "org-a", op);
    await workspaces.updateOperation(workspace.id, { ...op, status: "failed" }, op.id);
    const next = await workspaces.requestOperation(workspace.id, "org-a", {
      ...op,
      id: "new-reviewed-resize",
      resources: { ...resources, memoryMb: 16384 },
    });
    expect(next.operation?.resources?.memoryMb).toBe(16384);
  });
  it("serializes placement with reviewed membership and empty-workspace deletion", async () => {
    const workspace = await createWorkspace();
    await addProject("member", workspace.id);
    await expect(
      workspaces.requestOperation(workspace.id, "org-a", {
        ...intent("resize"),
        resources,
        restartProjectIds: [],
      }),
    ).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_CHANGED" });
    await expect(
      workspaces.requestOperation(workspace.id, "org-a", intent("delete")),
    ).rejects.toThrow("Delete or migrate");
    await db.delete(schema.project).where(eq(schema.project.id, "member"));
    await workspaces.requestOperation(workspace.id, "org-a", intent("delete"));
    await expect(addProject("late", workspace.id)).rejects.toThrow("unavailable");
    await workspaces.finishDeletion(workspace.id, "org-a");
    expect(await workspaces.findById(workspace.id)).toBeUndefined();
  });
});
