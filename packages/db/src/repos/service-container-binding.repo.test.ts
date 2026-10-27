import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const repo = createServiceRepo(db, createEncryption("binding-repair-test-secret"));
let sequence = 0;
beforeAll(async () => {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await client.exec("SET session_replication_role = replica;");
});
afterAll(() => client.close());

async function fixture() {
  const id = `binding-${++sequence}`;
  const [project] = await db
    .insert(schema.project)
    .values({
      id,
      organizationId: "org-one",
      groupId: `app-${id}`,
      name: id,
      slug: id,
      activeDeploymentId: `dep-${id}`,
    })
    .returning();
  const [deployment] = await db
    .insert(schema.deployment)
    .values({
      id: project!.activeDeploymentId!,
      projectId: id,
      organizationId: "org-one",
      branch: "main",
      status: "ready",
      containerId: "historical-primary",
      meta: { serverId: "server-one" },
    })
    .returning();
  const services = await db
    .insert(schema.service)
    .values(
      Array.from({ length: 5 }, (_, i) => ({
        id: `svc-${id}-${i}`,
        projectId: id,
        name: `service-${i}`,
        image: "example:v1",
      })),
    )
    .returning();
  const rows = await db
    .insert(schema.serviceDeployment)
    .values(
      services.map((service) => ({
        id: `sd-${service.id}`,
        deploymentId: deployment!.id,
        serviceId: service.id,
        serviceName: service.name,
        containerId: `old-${service.id}`,
        status: "success",
        imageRef: "example:v1",
        imageDigest: "sha256:original",
        ip: "172.20.0.2",
        hostPort: 30100,
        durationMs: 1234,
        startedAt: new Date("2026-10-25T00:00:00Z"),
        finishedAt: new Date("2026-10-25T00:00:01.234Z"),
      })),
    )
    .returning();
  const input = {
    projectId: id,
    organizationId: "org-one",
    deploymentId: deployment!.id,
    serviceId: services[0]!.id,
    expectedContainerId: rows[0]!.containerId!,
    containerId: "replacement",
    expectedProjectUpdatedAt: project!.updatedAt,
    expectedServiceUpdatedAt: services[0]!.updatedAt,
  };
  return { project: project!, deployment: deployment!, services, rows, input };
}

describe("observed service container binding repair", () => {
  it("changes only the exact service binding under the same active release", async () => {
    const f = await fixture();
    expect(await repo.refreshContainerBinding(f.input)).toBe(true);
    const rows = await repo.listByDeployment(f.deployment.id);
    for (const old of f.rows) {
      const current = rows.find((row) => row.id === old.id)!;
      if (old.serviceId !== f.input.serviceId) expect(current).toEqual(old);
      else
        expect(current).toEqual({
          ...old,
          containerId: "replacement",
          updatedAt: expect.any(Date),
        });
    }
    expect(
      await db.query.project.findFirst({ where: eq(schema.project.id, f.project.id) }),
    ).toEqual(f.project);
    expect(
      await db.query.deployment.findFirst({ where: eq(schema.deployment.id, f.deployment.id) }),
    ).toEqual(f.deployment);
    expect(
      await repo.refreshContainerBinding({ ...f.input, containerId: "stale-second-observer" }),
    ).toBe(false);
  });

  it.each(["organization", "service", "container", "project revision", "service revision"])(
    "rejects a stale or foreign %s without touching the binding",
    async (mismatch) => {
      const f = await fixture();
      const input = { ...f.input };
      if (mismatch === "organization") input.organizationId = "org-other";
      if (mismatch === "service") input.serviceId = (await fixture()).services[0]!.id;
      if (mismatch === "container") input.expectedContainerId = "concurrent-replacement";
      if (mismatch === "project revision") input.expectedProjectUpdatedAt = new Date(0);
      if (mismatch === "service revision") input.expectedServiceUpdatedAt = new Date(0);
      expect(await repo.refreshContainerBinding(input)).toBe(false);
      expect(await repo.listByDeployment(f.deployment.id)).toEqual(f.rows);
    },
  );

  it.each([
    "active release",
    "disabled",
    "deleting",
    "stopped service",
    "disabled service",
    "deployment in flight",
  ])("does not repair after %s changes", async (change) => {
    const f = await fixture();
    if (change === "active release")
      await db
        .update(schema.project)
        .set({ activeDeploymentId: "another-release" })
        .where(eq(schema.project.id, f.project.id));
    if (change === "disabled")
      await db
        .update(schema.project)
        .set({ disabledAt: new Date() })
        .where(eq(schema.project.id, f.project.id));
    if (change === "deleting")
      await db
        .update(schema.project)
        .set({ deletionInProgress: true })
        .where(eq(schema.project.id, f.project.id));
    if (change === "stopped service")
      await db
        .update(schema.serviceDeployment)
        .set({ status: "stopped" })
        .where(eq(schema.serviceDeployment.id, f.rows[0]!.id));
    if (change === "disabled service")
      await db
        .update(schema.service)
        .set({ enabled: false })
        .where(eq(schema.service.id, f.input.serviceId));
    if (change === "deployment in flight")
      await db.insert(schema.deployment).values({
        id: `queued-${f.project.id}`,
        projectId: f.project.id,
        organizationId: "org-one",
        branch: "main",
        status: "queued",
      });
    const before = await repo.listByDeployment(f.deployment.id);
    expect(await repo.refreshContainerBinding(f.input)).toBe(false);
    expect(await repo.listByDeployment(f.deployment.id)).toEqual(before);
  });
});
