import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { assertResourceInOrg } from "../../lib/resource-access";

export async function assertServiceAccess(
  ctx: Pick<ExecutionContext, "organizationId">,
  projectId: string,
  serviceId: string,
) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  const svc = await repos.service.findById(serviceId);
  if (!svc || svc.projectId !== projectId) throw new Error("service-not-found");
  return { project, svc };
}
