import { eq, isNull, sql } from "drizzle-orm";
import { project, deployment } from "../schema";

/** undefined is an organization-wide query; null selects its original dedicated Cloud resources. */
export function projectWorkspaceScope(workspaceId?: string | null) {
  return workspaceId === undefined
    ? undefined
    : workspaceId === null
      ? isNull(project.workspaceId)
      : eq(project.workspaceId, workspaceId);
}

/** Billing history follows the frozen execution target, including after a manual migration. */
export function deploymentWorkspaceScope(workspaceId?: string | null) {
  return workspaceId === undefined
    ? undefined
    : workspaceId === null
      ? sql`${deployment.meta}->>'managedWorkspaceId' IS NULL`
      : sql`${deployment.meta}->>'managedWorkspaceId' = ${workspaceId}`;
}
