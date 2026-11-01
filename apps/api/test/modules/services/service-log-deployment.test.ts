import { beforeEach, expect, it, vi } from "vitest";
import { seedOrg, seedProject, seedDeployment, seedService, setActive } from "../../helpers/seed";
import { getServiceRuntimeLogs, streamServiceRuntimeLogs } from "@repo/platform/engine/modules/services/service.service";

const runtime = vi.hoisted(() => vi.fn());
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({ resolveDeploymentRuntimeForRead: runtime }));
beforeEach(() => { runtime.mockReset(); });

it.each(["history", "stream"])("refuses %s for an old deployment before opening the current service runtime", async kind => {
  const ctx = await seedOrg();
  const project = await seedProject(ctx.organizationId);
  const service = await seedService(project.id, { name: "api", image: "node:22" });
  const old = await seedDeployment(project);
  const current = await seedDeployment(project);
  await setActive(project.id, current.id);
  const pending = kind === "history"
    ? getServiceRuntimeLogs(ctx, project.id, service.id, 100, old.id)
    : streamServiceRuntimeLogs(ctx, project.id, service.id, vi.fn(), { tail: 100, deploymentId: old.id });
  await expect(pending).rejects.toMatchObject({ code: "DEPLOYMENT_NOT_ACTIVE" });
  expect(runtime).not.toHaveBeenCalled();
});
