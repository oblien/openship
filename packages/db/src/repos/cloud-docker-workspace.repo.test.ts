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
const input = { projectId: "project-a", namespace: "namespace-a", image: "oblien/docker:29",
  resources: { cpuCores: 2, memoryMb: 4096, diskMb: 32768 } };
beforeAll(async () => { await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) }); });
afterAll(async () => { await client.close(); });
beforeEach(async () => {
  await db.delete(schema.organization);
  await db.insert(schema.organization).values([{ id: "org-a", name: "A" }, { id: "org-b", name: "B" }]);
  await db.insert(schema.projectGroup).values([
    { id: "group-a", organizationId: "org-a", name: "A", slug: "a" },
    { id: "group-b", organizationId: "org-b", name: "B", slug: "b" },
  ]);
  await db.insert(schema.project).values([
    { id: "project-a", groupId: "group-a", organizationId: "org-a", name: "A", slug: "a" },
    { id: "project-b", groupId: "group-b", organizationId: "org-b", name: "B", slug: "b" },
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
    expect(await repo.find(input.projectId, "org-b")).toBeUndefined();
    await expect(repo.reserve(input, "org-b")).rejects.toThrow();
    await expect(repo.attach(input.projectId, "org-b", input.namespace, "workspace-a")).rejects.toThrow();
    await expect(repo.markReady(input.projectId, "org-b", "workspace-a")).rejects.toThrow();
  });
  it("attaches the canonical host atomically and cannot rebind it or its namespace", async () => {
    await repo.reserve(input, "org-a");
    await repo.attach(input.projectId, "org-a", input.namespace, "workspace-a");
    await repo.attach(input.projectId, "org-a", input.namespace, "workspace-a");
    expect((await db.query.project.findFirst({ where: eq(schema.project.id, input.projectId) }))?.cloudWorkspaceId).toBe("workspace-a");
    await expect(repo.attach(input.projectId, "org-a", input.namespace, "workspace-b")).rejects.toThrow();
    await expect(repo.reserve({ ...input, namespace: "namespace-b" }, "org-a")).rejects.toThrow();
    await repo.markReady(input.projectId, "org-a", "workspace-a");
    expect((await repo.find(input.projectId, "org-a"))?.state).toBe("ready");
  });
  it("rolls back attachment if an older native workspace is already bound", async () => {
    await repo.reserve(input, "org-a");
    await db.update(schema.project).set({ cloudWorkspaceId: "native-workspace" }).where(eq(schema.project.id, input.projectId));
    await expect(repo.attach(input.projectId, "org-a", input.namespace, "workspace-a")).rejects.toThrow();
    expect((await repo.find(input.projectId, "org-a"))?.workspaceId).toBeNull();
  });
  it("fences provisioning once deletion has claimed the project", async () => {
    await repo.reserve(input, "org-a");
    await db.update(schema.project).set({ deletionInProgress: true }).where(eq(schema.project.id, input.projectId));
    await expect(repo.reserve(input, "org-a")).rejects.toThrow();
    await expect(repo.attach(input.projectId, "org-a", input.namespace, "workspace-a")).rejects.toThrow();
    // Cleanup still needs to see a pending/attached binding.
    expect(await repo.find(input.projectId, "org-a")).toBeDefined();
  });
  it("does not allow two projects to claim the same provider workspace", async () => {
    await repo.reserve(input, "org-a");
    await repo.attach(input.projectId, "org-a", input.namespace, "workspace-a");
    await repo.reserve({ ...input, projectId: "project-b", namespace: "namespace-b" }, "org-b");
    await expect(repo.attach("project-b", "org-b", "namespace-b", "workspace-a")).rejects.toThrow();
  });
  it("discards only an uncreated reservation owned by the requesting organization", async () => {
    const row = await repo.reserve(input, "org-a");
    await repo.discardUncreated(input.projectId, "org-b", row.provisionKey);
    await repo.discardUncreated(input.projectId, "org-a", "different-attempt");
    expect(await repo.find(input.projectId, "org-a")).toBeDefined();
    await repo.discardUncreated(input.projectId, "org-a", row.provisionKey);
    expect(await repo.find(input.projectId, "org-a")).toBeUndefined();
    const created = await repo.reserve(input, "org-a");
    await repo.attach(input.projectId, "org-a", input.namespace, "workspace-a");
    await repo.discardUncreated(input.projectId, "org-a", created.provisionKey);
    expect((await repo.find(input.projectId, "org-a"))?.workspaceId).toBe("workspace-a");
  });
  it("recovers a provider identity during deletion only for the deleting project's owner", async () => {
    await repo.reserve(input, "org-a");
    await expect(repo.attach(input.projectId, "org-a", input.namespace, "workspace-a", true)).rejects.toThrow();
    await db.update(schema.project).set({ deletionInProgress: true }).where(eq(schema.project.id, input.projectId));
    await expect(repo.attach(input.projectId, "org-b", input.namespace, "workspace-a", true)).rejects.toThrow();
    await repo.attach(input.projectId, "org-a", input.namespace, "workspace-a", true);
    expect((await repo.find(input.projectId, "org-a"))?.workspaceId).toBe("workspace-a");
  });
});
