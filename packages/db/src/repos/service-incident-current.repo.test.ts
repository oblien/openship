import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import * as schema from "../schema";
import { createServiceIncidentRepo } from "./service-incident.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createServiceIncidentRepo(db);
let next = 0;
beforeAll(async () => {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
  });
  await client.exec("SET session_replication_role = replica;");
}, 30_000);
afterAll(() => client.close());

async function workload(service = true) {
  const id = `health-${++next}`;
  const project = {
    id,
    organizationId: "org-one",
    name: id,
    slug: id,
    groupId: `app-${id}`,
    activeDeploymentId: `dep-${id}`,
  };
  await db.insert(schema.project).values(project);
  await db.insert(schema.deployment).values({
    id: project.activeDeploymentId,
    projectId: id,
    organizationId: project.organizationId,
    branch: "main",
    status: "ready",
    containerId: `app-${id}`,
  });
  if (service) {
    await db
      .insert(schema.service)
      .values({ id: `svc-${id}`, projectId: id, name: "api" });
    await db.insert(schema.serviceDeployment).values({
      id: `sd-${id}`,
      deploymentId: project.activeDeploymentId,
      serviceId: `svc-${id}`,
      containerId: `container-${id}`,
      status: "success",
    });
  }
  const incident = await repo.open({
    organizationId: project.organizationId,
    projectId: id,
    serviceId: service ? `svc-${id}` : null,
    serviceKey: service ? `svc-${id}` : "__app__",
    serviceName: "api",
    containerId: service ? `container-${id}` : `app-${id}`,
    kind: "crash_loop",
  });
  return { project, incident: incident! };
}

describe("current workload incidents", () => {
  it("reads old open incidents beyond recent history and clears on the watcher's normal resolution", async () => {
    const { project, incident } = await workload();
    for (let i = 0; i < 60; i++)
      await db.insert(schema.serviceIncident).values({
        ...incident,
        id: `history-${i}-${project.id}`,
        serviceKey: `history-${i}`,
        status: "resolved",
        openedAt: new Date(Date.now() + i),
        resolvedAt: new Date(),
      });
    expect(await repo.listForProject(project.id)).toHaveLength(50);
    expect(await repo.listOpenForActiveProjects([project])).toEqual([incident]);
    await repo.escalate(incident.id, "crash_loop", "down", {});
    expect((await repo.listOpenForActiveProjects([project]))[0]?.kind).toBe(
      "down",
    );
    await repo.resolve(incident.id);
    expect(await repo.listOpenForActiveProjects([project])).toEqual([]);
    expect(
      (
        await db.query.deployment.findFirst({
          where: eq(schema.deployment.id, project.activeDeploymentId),
        })
      )?.status,
    ).toBe("ready");
  });

  it("excludes foreign orgs, invalid active bindings and stale containers after a release switch", async () => {
    const a = await workload();
    const b = await workload();
    expect(
      await repo.listOpenForActiveProjects([
        { ...a.project, organizationId: "foreign" },
      ]),
    ).toEqual([]);
    await db
      .update(schema.serviceIncident)
      .set({ organizationId: "foreign" })
      .where(eq(schema.serviceIncident.id, a.incident.id));
    expect(await repo.listOpenForActiveProjects([a.project])).toEqual([]);
    await db
      .update(schema.serviceIncident)
      .set({ organizationId: a.project.organizationId })
      .where(eq(schema.serviceIncident.id, a.incident.id));
    await db
      .update(schema.serviceDeployment)
      .set({ containerId: "replacement" })
      .where(eq(schema.serviceDeployment.serviceId, a.incident.serviceId!));
    expect(await repo.listOpenForActiveProjects([a.project])).toEqual([]);
    await db
      .update(schema.project)
      .set({ activeDeploymentId: b.project.activeDeploymentId })
      .where(eq(schema.project.id, a.project.id));
    expect(
      await repo.listOpenForActiveProjects([
        { ...a.project, activeDeploymentId: b.project.activeDeploymentId },
      ]),
    ).toEqual([]);
  });

  it("rechecks the active pointer at read time and keeps carried current containers", async () => {
    const { project, incident } = await workload();
    const nextDeployment = `${project.activeDeploymentId}-next`;
    await db
      .insert(schema.deployment)
      .values({
        id: nextDeployment,
        projectId: project.id,
        organizationId: project.organizationId,
        branch: "main",
        status: "ready",
      });
    await db
      .insert(schema.serviceDeployment)
      .values({
        id: `carried-${project.id}`,
        serviceId: incident.serviceId!,
        deploymentId: nextDeployment,
        status: "success",
        containerId: incident.containerId,
      });
    await db
      .update(schema.project)
      .set({ activeDeploymentId: nextDeployment })
      .where(eq(schema.project.id, project.id));
    expect(await repo.listOpenForActiveProjects([project])).toEqual([]);
    const current = { ...project, activeDeploymentId: nextDeployment };
    expect(await repo.listOpenForActiveProjects([current])).toEqual([incident]);
    await db
      .update(schema.serviceDeployment)
      .set({ containerId: "new-container" })
      .where(eq(schema.serviceDeployment.id, `carried-${project.id}`));
    expect(await repo.listOpenForActiveProjects([current])).toEqual([]);
  });

  it.each(["stored", "missing"] as const)(
    "keeps recreated service incidents current with a %s container hint and retires replaced bindings",
    async (hint) => {
      const { project, incident } = await workload();
      const trackedContainerId = hint === "stored" ? incident.containerId : null;
      if (hint === "missing")
        await db
          .update(schema.serviceDeployment)
          .set({ containerId: null })
          .where(eq(schema.serviceDeployment.serviceId, incident.serviceId!));
      // The watcher discovers the replacement by labels/name/Compose, without
      // mutating the deployment's identity hint. Its durable observation binds
      // the actual container back to the release and hint it was watching.
      await repo.touch(incident.id, {
        containerId: `recreated-${project.id}`,
        deploymentId: project.activeDeploymentId,
        trackedContainerId,
      });
      expect((await repo.listOpenForActiveProjects([project])).map((row) => row.id)).toEqual([
        incident.id,
      ]);

      // A service replacement can update the hint within the SAME release.
      await db
        .update(schema.serviceDeployment)
        .set({ containerId: `replacement-${project.id}` })
        .where(eq(schema.serviceDeployment.serviceId, incident.serviceId!));
      expect(await repo.listOpenForActiveProjects([project])).toEqual([]);

      // A later release can also carry the old hint forward. It must be observed
      // again before attributing the recreated container's fault to that release.
      const nextDeployment = `${project.activeDeploymentId}-next`;
      await db.insert(schema.deployment).values({
        id: nextDeployment,
        projectId: project.id,
        organizationId: project.organizationId,
        branch: "main",
        status: "ready",
      });
      await db.insert(schema.serviceDeployment).values({
        id: `next-${project.id}`,
        deploymentId: nextDeployment,
        serviceId: incident.serviceId!,
        containerId: trackedContainerId,
        status: "success",
      });
      await db
        .update(schema.project)
        .set({ activeDeploymentId: nextDeployment })
        .where(eq(schema.project.id, project.id));
      const current = { ...project, activeDeploymentId: nextDeployment };
      expect(await repo.listOpenForActiveProjects([current])).toEqual([]);
      await repo.escalate(incident.id, "crash_loop", "down", {
        deploymentId: nextDeployment,
        trackedContainerId,
      });
      expect((await repo.listOpenForActiveProjects([current])).map((row) => row.id)).toEqual([
        incident.id,
      ]);
    },
  );

  it("excludes deliberate service/project stops and monitoring opt-outs", async () => {
    for (const mode of [
      "stopped",
      "disabled",
      "monitoring",
      "project",
      "deleted",
    ]) {
      const { project, incident } = await workload();
      if (mode === "stopped")
        await db
          .update(schema.serviceDeployment)
          .set({ status: "stopped" })
          .where(eq(schema.serviceDeployment.serviceId, incident.serviceId!));
      if (mode === "disabled")
        await db
          .update(schema.service)
          .set({ enabled: false })
          .where(eq(schema.service.id, incident.serviceId!));
      if (mode === "monitoring")
        await db
          .update(schema.service)
          .set({ advanced: { monitoringEnabled: false } })
          .where(eq(schema.service.id, incident.serviceId!));
      if (mode === "deleted")
        await db
          .update(schema.project)
          .set({ deletedAt: new Date() })
          .where(eq(schema.project.id, project.id));
      if (mode === "project")
        await db
          .update(schema.project)
          .set({ disabledAt: new Date() })
          .where(eq(schema.project.id, project.id));
      expect(await repo.listOpenForActiveProjects([project])).toEqual([]);
    }
  });

  it("includes single-app and recorded role incidents only for their exact current containers", async () => {
    const { project, incident } = await workload(false);
    await db
      .update(schema.deployment)
      .set({
        roleContainers: [
          { role: "worker", replica: 1, containerId: "role-current" },
        ],
      })
      .where(eq(schema.deployment.id, project.activeDeploymentId));
    const role = await repo.open({
      ...incident,
      serviceKey: "__role__:worker:1",
      containerId: "role-current",
      kind: "unhealthy",
    });
    expect(
      (await repo.listOpenForActiveProjects([project]))
        .map((row) => row.id)
        .sort(),
    ).toEqual([incident.id, role!.id].sort());
    await db
      .update(schema.serviceIncident)
      .set({ containerId: "role-old" })
      .where(eq(schema.serviceIncident.id, role!.id));
    expect(
      (await repo.listOpenForActiveProjects([project])).map((row) => row.id),
    ).toEqual([incident.id]);
    expect(await repo.listOpenForActiveProjects([])).toEqual([]);
    // Moving to service-based workloads must not retain the old single-app warning.
    await db.insert(schema.service).values({
      id: `new-service-${project.id}`,
      projectId: project.id,
      name: "replacement",
    });
    expect(await repo.listOpenForActiveProjects([project])).toEqual([]);
    await db
      .delete(schema.service)
      .where(eq(schema.service.projectId, project.id));
    await db
      .update(schema.project)
      .set({ disabledAt: new Date() })
      .where(eq(schema.project.id, project.id));
    expect(await repo.listOpenForActiveProjects([project])).toEqual([]);
  });
});
