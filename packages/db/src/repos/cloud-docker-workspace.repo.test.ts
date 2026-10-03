import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createCloudDockerWorkspaceRepo } from "./cloud-docker-workspace.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createCloudDockerWorkspaceRepo(db);
const input = { ownerWorkspaceId: "owner-a", namespace: "namespace-a", image: "oblien/docker:29",
  resources: { cpuCores: 2, memoryMb: 4096, diskMb: 32768 } };
beforeAll(async () => { await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) }); });
afterAll(async () => { await client.close(); });
beforeEach(async () => {
  await db.delete(schema.cloudDockerWorkspace);
  await db.delete(schema.project);
  await db.delete(schema.servers);
  await db.delete(schema.cloudWorkspace);
  await db.delete(schema.organization);
  await db.insert(schema.organization).values([{ id: "org-a", name: "A" }, { id: "org-b", name: "B" }]);
  await db.insert(schema.projectGroup).values([
    { id: "group-a", organizationId: "org-a", name: "A", slug: "a" },
    { id: "group-b", organizationId: "org-b", name: "B", slug: "b" },
  ]);
  await db.insert(schema.cloudWorkspace).values([
    { id: "owner-a", organizationId: "org-a", name: "A", namespace: "namespace-a" },
    { id: "owner-b", organizationId: "org-b", name: "B", namespace: "namespace-b" },
  ]);
  await db.insert(schema.servers).values([
    { id: "server-a", organizationId: "org-a", name: "A", workspaceId: "owner-a" },
    { id: "server-b", organizationId: "org-b", name: "B", workspaceId: "owner-b" },
  ]);
  await db.insert(schema.project).values([
    { id: "project-a", serverId: "server-a", groupId: "group-a", organizationId: "org-a", name: "A", slug: "a" },
    { id: "project-b", serverId: "server-b", groupId: "group-b", organizationId: "org-b", name: "B", slug: "b" },
  ]);
});
describe("durable Cloud Docker workspace ownership", () => {
  it("reserves one idempotency key with frozen resources under concurrent deploys", async () => {
    const [first, second] = await Promise.all([repo.reserve(input, "org-a"), repo.reserve({ ...input, resources: { ...input.resources, memoryMb: 8192 } }, "org-a")]);
    expect(first.provisionKey).toBe(second.provisionKey);
    expect(first.resources).toEqual(second.resources);
    expect(first.workspaceId).toBeNull();
  });
  it("rejects cross-organization reads and every mutation", async () => {
    await repo.reserve(input, "org-a");
    expect(await repo.find("project-a", "org-b")).toBeUndefined();
    await expect(repo.reserve(input, "org-b")).rejects.toThrow();
    await expect(repo.attach("project-a", "org-b", input.namespace, "workspace-a")).rejects.toThrow();
    await expect(repo.markReady("project-a", "org-b", "workspace-a")).rejects.toThrow();
  });
  it("attaches the canonical host atomically and cannot rebind it or its namespace", async () => {
    await repo.reserve(input, "org-a");
    await repo.attach("project-a", "org-a", input.namespace, "workspace-a");
    await repo.attach("project-a", "org-a", input.namespace, "workspace-a");
    expect((await db.query.project.findFirst({ where: eq(schema.project.id, "project-a") }))?.workspaceId).toBe("owner-a");
    await expect(repo.attach("project-a", "org-a", input.namespace, "workspace-b")).rejects.toThrow();
    await expect(repo.reserve({ ...input, namespace: "namespace-b" }, "org-a")).rejects.toThrow();
    await repo.markReady("project-a", "org-a", "workspace-a");
    expect((await repo.find("project-a", "org-a"))?.state).toBe("ready");
  });
  it("retains the shared host after a member project is removed", async () => {
    await repo.reserve(input, "org-a");
    await repo.attach("project-a", "org-a", input.namespace, "workspace-a");
    await db.delete(schema.project).where(eq(schema.project.id, "project-a"));
    expect(await repo.find("project-a", "org-a")).toBeUndefined();
    expect(await repo.find({ ownerWorkspaceId: "owner-a" }, "org-a")).toMatchObject({ workspaceId: "workspace-a" });
  });
  it("fences provisioning once deletion has claimed the managed server", async () => {
    await repo.reserve(input, "org-a");
    await db.update(schema.cloudWorkspace).set({ deletionInProgress: new Date() }).where(eq(schema.cloudWorkspace.id, "owner-a"));
    await expect(repo.reserve(input, "org-a")).rejects.toThrow();
    await expect(repo.attach("project-a", "org-a", input.namespace, "workspace-a")).rejects.toThrow();
    // Cleanup still needs to see a pending/attached binding.
    expect(await repo.find("project-a", "org-a")).toBeDefined();
  });
  it("does not allow two servers to claim the same provider workspace", async () => {
    await repo.reserve(input, "org-a");
    await repo.attach("project-a", "org-a", input.namespace, "workspace-a");
    await repo.reserve({ ...input, ownerWorkspaceId: "owner-b", namespace: "namespace-b" }, "org-b");
    await expect(repo.attach("project-b", "org-b", "namespace-b", "workspace-a")).rejects.toThrow();
  });
  it("discards only an uncreated reservation owned by the requesting organization", async () => {
    const row = await repo.reserve(input, "org-a");
    await repo.discardUncreated("project-a", "org-b", row.provisionKey);
    await repo.discardUncreated("project-a", "org-a", "different-attempt");
    expect(await repo.find("project-a", "org-a")).toBeDefined();
    await repo.discardUncreated("project-a", "org-a", row.provisionKey);
    expect(await repo.find("project-a", "org-a")).toBeUndefined();
    const created = await repo.reserve(input, "org-a");
    await repo.attach("project-a", "org-a", input.namespace, "workspace-a");
    await repo.discardUncreated("project-a", "org-a", created.provisionKey);
    expect((await repo.find("project-a", "org-a"))?.workspaceId).toBe("workspace-a");
  });
  it("recovers a provider identity during deletion only for the deleting project's owner", async () => {
    await repo.reserve(input, "org-a");
    await expect(repo.attach("project-a", "org-a", input.namespace, "workspace-a", true)).rejects.toThrow();
    await db.update(schema.project).set({ deletionInProgress: true }).where(eq(schema.project.id, "project-a"));
    await expect(repo.attach("project-a", "org-b", input.namespace, "workspace-a", true)).rejects.toThrow();
    await repo.attach("project-a", "org-a", input.namespace, "workspace-a", true);
    expect((await repo.find("project-a", "org-a"))?.workspaceId).toBe("workspace-a");
  });
});
