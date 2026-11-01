import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createEncryption } from "../encryption";
import { createConfigurationSecrets, CONFIGURATION_PREFIX } from "../configuration-secrets";
import { createDeploymentRepo, type DeploymentResourceChanges } from "./deployment.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const encryption = createEncryption("capacity-test-encryption-key");
const codec = createConfigurationSecrets(encryption);
const repo = createDeploymentRepo(db, encryption);
const services = async () => (await db.select().from(schema.service)).map(codec.openService);
const stamp = new Date("2026-09-30T12:00:00Z");
const previous = { cpuCores: 1, memoryMb: 1024, diskMb: 8192 };
const next = { cpuCores: 0.25, memoryMb: 256, diskMb: 8192 };
const preserved = {
  resources: previous,
  files: [{ path: "/app/config", content: "keep-me" }],
  healthcheck: { test: ["CMD", "true"] },
};
const changes = (): DeploymentResourceChanges => ({
  expectedActiveDeploymentId: "active",
  expectedProjectUpdatedAt: stamp,
  services: [
    { serviceId: "one", expectedResources: previous, expectedUpdatedAt: stamp, resources: next },
    { serviceId: "two", expectedResources: previous, expectedUpdatedAt: stamp, resources: next },
  ],
});
const deploy = {
  projectId: "project",
  organizationId: "org",
  branch: "main",
  status: "queued",
  meta: { capacityAdjustment: { key: "operation-key", requestHash: "request" } },
};

beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await client.exec("SET session_replication_role = replica;");
});
afterAll(() => client.close());
beforeEach(async () => {
  await client.exec("TRUNCATE build_session, service, deployment, project CASCADE");
  await db.insert(schema.project).values({
    id: "project",
    organizationId: "org",
    groupId: "group",
    name: "App",
    slug: "app",
    activeDeploymentId: "active",
    updatedAt: stamp,
  });
  await db.insert(schema.deployment).values({
    id: "active",
    projectId: "project",
    organizationId: "org",
    branch: "main",
    status: "ready",
  });
  await db.insert(schema.service).values(
    ["one", "two"].map((id) =>
      codec.sealService({
        id,
        name: id,
        projectId: "project",
        updatedAt: stamp,
        environment: { SECRET: "keep-encrypted-envelope" },
        advanced: preserved,
      }),
    ),
  );
});

describe("resource edits and deployment admission", () => {
  it("commits both resource edits and the queue while preserving other service configuration", async () => {
    const before = await db.select().from(schema.service);
    const dep = await repo.create(deploy, changes());
    expect(dep?.id).toBeTruthy();
    expect(await repo.findBuildSessionByDeploymentId(dep!.id)).toMatchObject({
      status: "queued",
      projectId: "project",
    });
    const rows = await services();
    for (const row of rows) {
      expect(row.advanced).toEqual({ ...preserved, resources: next });
      expect(row.environment).toEqual({ SECRET: "keep-encrypted-envelope" });
    }
    for (const stored of await db.select().from(schema.service)) {
      expect(stored.environment).toEqual(before.find((row) => row.id === stored.id)!.environment);
      expect(stored.advanced).toEqual(expect.stringContaining(CONFIGURATION_PREFIX));
      expect(JSON.stringify(stored)).not.toMatch(/keep-me|keep-encrypted-envelope/);
    }
    expect((await repo.findCapacityAdjustment("project", "org", "operation-key"))?.id).toBe(
      dep!.id,
    );
    expect(
      await repo.findCapacityAdjustment("project", "foreign", "operation-key"),
    ).toBeUndefined();
  });

  it("rolls back the first service and queued deployment when a later service changed", async () => {
    await db
      .update(schema.service)
      .set(codec.sealService({ advanced: { resources: next } }))
      .where(eq(schema.service.id, "two"));
    await expect(repo.create(deploy, changes())).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_CHANGED",
    });
    const one = (await services()).find((s) => s.id === "one");
    expect(one!.advanced).toEqual(preserved);
    expect(await db.select().from(schema.buildSession)).toHaveLength(0);
    expect(await db.select().from(schema.deployment)).toHaveLength(1);
  });

  it("rejects stale previews after unrelated service settings changed", async () => {
    await db
      .update(schema.service)
      .set({ updatedAt: new Date(stamp.getTime() + 1000) })
      .where(eq(schema.service.id, "one"));
    await expect(repo.create(deploy, changes())).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_CHANGED",
    });
    expect(await db.select().from(schema.buildSession)).toHaveLength(0);
  });

  it("rejects a new active deployment without changing any service", async () => {
    await db
      .update(schema.project)
      .set({ activeDeploymentId: "different" })
      .where(eq(schema.project.id, "project"));
    await expect(repo.create(deploy, changes())).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_CHANGED",
    });
    expect((await services()).every((s) => s.advanced?.resources?.cpuCores === 1)).toBe(true);
  });

  it("does not save overrides when deletion or another deployment owns admission", async () => {
    await repo.create(deploy);
    expect(await repo.create(deploy, changes())).toBeUndefined();
    expect((await services()).every((s) => s.advanced?.resources?.cpuCores === 1)).toBe(true);
  });

  it("refuses cross-tenant service edits transactionally", async () => {
    await db
      .update(schema.service)
      .set({ projectId: "foreign" })
      .where(eq(schema.service.id, "two"));
    await expect(repo.create(deploy, changes())).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_CHANGED",
    });
    expect(await db.select().from(schema.deployment)).toHaveLength(1);
    expect(await db.select().from(schema.buildSession)).toHaveLength(0);
  });

  it("verifies unchanged sibling settings used by the preview", async () => {
    const input = changes();
    delete input.services[1]!.resources;
    await db
      .update(schema.service)
      .set({ updatedAt: new Date(stamp.getTime() + 1000) })
      .where(eq(schema.service.id, "two"));
    await expect(repo.create(deploy, input)).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_CHANGED",
    });
    expect((await services()).find((s) => s.id === "one")!.advanced).toEqual(preserved);
    expect(await db.select().from(schema.buildSession)).toHaveLength(0);
  });

  it("refuses an unreviewed sibling added before admission", async () => {
    await db
      .insert(schema.service)
      .values({ id: "new", name: "unreviewed", projectId: "project", enabled: false });
    await expect(repo.create(deploy, changes())).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_CHANGED",
    });
    expect((await services()).find((s) => s.id === "one")!.advanced).toEqual(preserved);
    expect(await db.select().from(schema.buildSession)).toHaveLength(0);
  });

  it("does not overwrite an unchanged sibling or its update timestamp", async () => {
    const input = changes();
    delete input.services[1]!.resources;
    await repo.create(deploy, input);
    const two = (await services()).find((s) => s.id === "two");
    expect(two!.updatedAt).toEqual(stamp);
    expect(two!.advanced).toEqual(preserved);
  });

  it("rejects project settings changed after preview", async () => {
    await db
      .update(schema.project)
      .set({ updatedAt: new Date(stamp.getTime() + 1000) })
      .where(eq(schema.project.id, "project"));
    await expect(repo.create(deploy, changes())).rejects.toMatchObject({
      code: "CLOUD_CAPACITY_CHANGED",
    });
    expect(await db.select().from(schema.buildSession)).toHaveLength(0);
  });

  it("reads legacy plaintext settings and seals the edited field without dropping inline files", async () => {
    await db.update(schema.service).set({ advanced: preserved });
    await repo.create(deploy, changes());
    expect((await services()).map((s) => s.advanced)).toEqual([
      { ...preserved, resources: next },
      { ...preserved, resources: next },
    ]);
    expect(
      (await db.select().from(schema.service)).every((s) => typeof s.advanced === "string"),
    ).toBe(true);
  });
});
