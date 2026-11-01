import { expect, it, vi } from "vitest";
import { repos } from "@repo/db";
import type { RuntimeAdapter } from "@repo/adapters";
import {
  seedOrg,
  seedProject,
  seedDeployment,
  seedService,
  seedServiceDeployment,
} from "../../helpers/seed";
import {
  onFailure,
  onCancelled,
} from "@repo/platform/engine/modules/deployments/deployment-lifecycle";

it.each(["failure", "cancel"])(
  "reconstructed %s cleanup retains confirmed infrastructure, not unrelated or failed containers",
  async (outcome) => {
    const owner = await seedOrg();
    const project = await seedProject(owner.organizationId);
    const database = await seedService(project.id, {
      name: "database",
      image: "postgres:16-alpine",
    });
    const unrelated = await seedService(project.id, { name: "unrelated", image: "busybox:1.37" });
    const failed = await seedService(project.id, {
      name: "failed-database",
      image: "postgres:16-alpine",
    });
    const dep = await seedDeployment(project, {
      status: "deploying",
      meta: {
        attachedInfrastructureServiceIds: [database.id, failed.id, "foreign-service"],
      },
    });
    await seedServiceDeployment(dep.id, database, {
      containerId: "ready-database",
      status: "success",
    });
    await seedServiceDeployment(dep.id, unrelated, { containerId: "temporary", status: "success" });
    await seedServiceDeployment(dep.id, failed, {
      containerId: "failed-database",
      status: "failed",
    });
    const session = await repos.deployment.createBuildSession({
      deploymentId: dep.id,
      projectId: project.id,
      status: "deploying",
    });
    const destroy = vi.fn(async (_id: string) => {});
    // This has no process-local infrastructure keep list: it is the context a
    // recovery worker reconstructs after a control-plane crash.
    const ctx = {
      project,
      dep,
      runtime: { destroy } as unknown as RuntimeAdapter,
      buildSessionId: session.id,
      provisioned: {},
      persistLogs: () => [],
    };
    if (outcome === "failure") await onFailure(ctx, "migration failed");
    else await onCancelled(ctx);
    expect(destroy.mock.calls.map((call) => call[0]).sort()).toEqual([
      "failed-database",
      "temporary",
    ]);
    expect(
      (await repos.service.listByDeployment(dep.id)).find((row) => row.serviceId === database.id),
    ).toMatchObject({ status: "success", containerId: "ready-database" });
  },
);
