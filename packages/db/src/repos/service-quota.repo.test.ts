import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createEncryption } from "../encryption";
import { createServiceRepo } from "./service.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createServiceRepo(db, createEncryption("quota-repository-test"));
beforeAll(async () => { await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) }); });
afterAll(async () => { await client.close(); });
beforeEach(async () => {
  await db.delete(schema.organization);
  for (const suffix of ["a", "b"]) {
    await db.insert(schema.organization).values({ id: `org-${suffix}`, name: suffix });
    await db.insert(schema.projectGroup).values({ id: `group-${suffix}`, organizationId: `org-${suffix}`, name: suffix, slug: suffix });
    await db.insert(schema.project).values({ id: `project-${suffix}`, groupId: `group-${suffix}`, organizationId: `org-${suffix}`, name: suffix, slug: suffix, activeDeploymentId: `active-${suffix}` });
    await db.insert(schema.deployment).values({ id: `active-${suffix}`, projectId: `project-${suffix}`, organizationId: `org-${suffix}`, branch: "main", status: "ready" });
  }
});
async function service(id: string, options: { enabled?: boolean; project?: string; status?: string; containerId?: string | null; deploymentId?: string } = {}) {
  const suffix = options.project ?? "a";
  await db.insert(schema.service).values({ id, projectId: `project-${suffix}`, name: id, enabled: options.enabled ?? true });
  if (options.status) await db.insert(schema.serviceDeployment).values({
    id: `sd-${id}`, serviceId: id, deploymentId: options.deploymentId ?? `active-${suffix}`,
    status: options.status, containerId: options.containerId === undefined ? `container-${id}` : options.containerId,
  });
}

describe("customer service quota accounting", () => {
  it("reserves enabled definitions and excludes other organizations", async () => {
    await service("one"); await service("two"); await service("foreign", { project: "b" });
    expect(await repo.countRunningForOrg("org-a")).toBe(2);
    expect(await repo.countRunningForOrg("org-b")).toBe(1);
    expect(await repo.countRunningForOrg("org-a", ["one"])).toBe(1);
  });
  it("reserves queued stack names once before and after service synchronization", async () => {
    await service("saved");
    await db.insert(schema.deployment).values({
      id: "queued-stack", projectId: "project-a", organizationId: "org-a", branch: "main", status: "queued",
      meta: { cloudApplicationSlot: false, cloudServiceSlots: ["saved", "new"] },
    });
    expect(await repo.countRunningForOrg("org-a")).toBe(2);
    expect(await repo.countRunningForOrg("org-a", [], undefined, { projectId: "project-a", serviceNames: ["saved", "new"] })).toBe(2);
    await service("new", { enabled: false });
    expect(await repo.countRunningForOrg("org-a")).toBe(2);
    expect(await repo.countRunningForOrg("org-a", ["new"])).toBe(1);
    await db.update(schema.deployment).set({ status: "cancelled" }).where(eq(schema.deployment.id, "queued-stack"));
    expect(await repo.countRunningForOrg("org-a")).toBe(1);
  });
  it("adds prospective services to the organization's existing slots by project and name", async () => {
    await service("saved");
    expect(await repo.countRunningForOrg("org-a", [], undefined, { projectId: "project-a", serviceNames: ["saved", "new"] })).toBe(2);
    expect(await repo.countRunningForOrg("org-a", [], undefined, { projectId: "new-project", serviceNames: ["saved", "new"] })).toBe(3);
  });
  it.each(["success", "skipped", "failed"])("keeps a disabled %s service charged while its active container remains", async status => {
    await service("disabled-live", { enabled: false, status });
    expect(await repo.countRunningForOrg("org-a")).toBe(1);
    expect(await repo.countRunningForOrg("org-a", ["disabled-live"])).toBe(0);
  });
  it("frees disabled services after stopping, but an enabled service keeps its reservation", async () => {
    await service("off", { enabled: false, status: "stopped" });
    await service("absent", { enabled: false, status: "skipped", containerId: null });
    await service("reserved", { status: "stopped" });
    expect(await repo.countRunningForOrg("org-a")).toBe(1);
  });
  it("ignores archived containers and deleted projects", async () => {
    await db.insert(schema.deployment).values({ id: "old-a", projectId: "project-a", organizationId: "org-a", branch: "main", status: "ready" });
    await service("old", { enabled: false, status: "success", deploymentId: "old-a" });
    expect(await repo.countRunningForOrg("org-a")).toBe(0);
    await service("deleted-project-service");
    await db.update(schema.project).set({ deletedAt: new Date() }).where(eq(schema.project.id, "project-a"));
    expect(await repo.countRunningForOrg("org-a")).toBe(0);
  });
  it("counts native apps alongside auxiliary services and reserves only one slot during redeploy", async () => {
    await db.update(schema.deployment).set({ containerId: "native-vm", meta: { cloudApplicationSlot: true, hasServer: true } }).where(eq(schema.deployment.id, "active-a"));
    await db.insert(schema.deployment).values({ id: "queued-a", projectId: "project-a", organizationId: "org-a", branch: "main", status: "queued", meta: { cloudApplicationSlot: true, hasServer: true } });
    await service("database");
    expect(await repo.countRunningForOrg("org-a")).toBe(2);
    expect(await repo.countRunningForOrg("org-a", [], "project-a")).toBe(1);
  });
  it("does not charge static builds or completed failed queue reservations", async () => {
    await db.update(schema.deployment).set({ containerId: "static-page", meta: { hasServer: false } }).where(eq(schema.deployment.id, "active-a"));
    await db.insert(schema.deployment).values({ id: "failed-a", projectId: "project-a", organizationId: "org-a", branch: "main", status: "failed", meta: { cloudApplicationSlot: true, hasServer: true } });
    expect(await repo.countRunningForOrg("org-a")).toBe(0);
  });
  it("includes legacy native workers but does not count a Compose host as an extra app", async () => {
    await db.update(schema.deployment).set({ containerId: "native-vm", meta: { workload: "worker", hasServer: false } }).where(eq(schema.deployment.id, "active-a"));
    expect(await repo.countRunningForOrg("org-a")).toBe(1);
    await service("compose-app", { status: "success" });
    expect(await repo.countRunningForOrg("org-a")).toBe(1);
  });
  it("releases a paused native app but still counts an in-flight replacement", async () => {
    await db.update(schema.deployment).set({ containerId: "native-vm", meta: { cloudApplicationSlot: true } }).where(eq(schema.deployment.id, "active-a"));
    await db.update(schema.project).set({ disabledAt: new Date() }).where(eq(schema.project.id, "project-a"));
    expect(await repo.countRunningForOrg("org-a")).toBe(0);
    await db.insert(schema.deployment).values({ id: "queued-a", projectId: "project-a", organizationId: "org-a", branch: "main", status: "queued", meta: { cloudApplicationSlot: true } });
    expect(await repo.countRunningForOrg("org-a")).toBe(1);
  });
});
