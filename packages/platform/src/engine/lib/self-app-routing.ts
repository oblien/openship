import { findActiveDeployment } from "@repo/platform/engine/lib/active-deployment";
import type { ExecutionContext } from "../../context";
import { repos } from "@repo/db";
import { instanceAuthorization } from "./instance-authorization";

/** Reserved dashboard routing is an instance action, even from a project UI.
 * The editable catalog marker alone is never authority to expose host ports. */
export async function canRouteSelfApp(ctx: ExecutionContext, projectId: string): Promise<boolean> {
  const project = await repos.project.findById(projectId);
  if (
    project?.organizationId !== ctx.organizationId ||
    project.appTemplateId !== "openship" ||
    !project.activeDeploymentId
  )
    return false;
  const deployment = await findActiveDeployment(project);
  if (
    (deployment?.meta as { adopt?: boolean } | null)?.adopt !== true
  )
    return false;
  return instanceAuthorization.allows(ctx, "write");
}
