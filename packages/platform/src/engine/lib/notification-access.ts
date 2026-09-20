import { AppError, isRecord } from "@repo/contracts";
import type { ResourceType } from "@repo/core";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../context";
import { authorization } from "./authorization";
import { buildBackgroundContext } from "./background-context";
import { findCategory } from "./notification-categories";

const rooted = new Set(["project", "deployment", "service", "domain", "server", "mail_server", "backup_destination", "backup_policy", "backup_run", "backup_restore"]);
const singleton = new Set(["billing", "audit", "analytics", "github", "permissions", "settings", "cloud", "notifications", "updates"]);
const categoryResource: Record<string, ResourceType> = {
  deployment: "project", app_health: "project", backups: "backup_destination", jobs: "job", domains: "project", members: "permissions", mail: "mail_server", billing: "billing",
};

/** A stored subscription or delivery never keeps resource access after revocation. */
export async function canReadNotification(ctx: ExecutionContext, input: { category: string; payload: unknown }): Promise<boolean> {
  const context = { ...ctx, scopeMode: "fixed" as const };
  const read = (resourceType: ResourceType, resourceId = "*", all = false) => authorization.checkPermissionOnResource(context, { resourceType, resourceId, action: "read", ...(all && { scope: "all" as const }) });
  if (!(await read("notifications"))) return false;
  const payload = isRecord(input.payload) ? input.payload : {};
  const type = typeof payload.resourceType === "string" ? payload.resourceType : undefined;
  const id = typeof payload.resourceId === "string" ? payload.resourceId : undefined;
  if (type === "job" || input.category.startsWith("job.run.")) {
    if (!(await read("job"))) return false;
    const { requireReadableRun, requireReadableJob } = await import("../modules/jobs/job-access");
    try {
      if (typeof payload.runId === "string") await requireReadableRun(context, payload.runId);
      else if (id || typeof payload.jobKey === "string") await requireReadableJob(context, id ?? String(payload.jobKey));
      else return false;
      return true;
    } catch (error) { if (error instanceof AppError && [401, 403, 404].includes(error.statusCode)) return false; throw error; }
  }
  if (type && rooted.has(type)) {
    if (!id || !(await read(type as ResourceType, id))) return false;
    if (["backup_policy", "backup_run", "backup_restore"].includes(type)) {
      const source = type === "backup_policy" ? await repos.backupPolicy.findById(id) : type === "backup_run" ? await repos.backupRun.findById(id) : await repos.backupRestore.findById(id);
      if (!source) return false;
      if (source.projectId && !(await read("project", source.projectId))) return false;
      if ("mailServerId" in source && source.mailServerId && !(await read("mail_server", source.mailServerId))) return false;
      if ("runId" in source) {
        const original = await repos.backupRun.findById(source.runId);
        if (!original) return false;
        if (original.projectId && !(await read("project", original.projectId))) return false;
        if (original.mailServerId && !(await read("mail_server", original.mailServerId))) return false;
        if (source.forkMailServerId && !(await read("mail_server", source.forkMailServerId))) return false;
        if (source.forkServiceId && !(await read("service", source.forkServiceId))) return false;
      }
    }
    return true;
  }
  if (type && singleton.has(type)) return read(type as ResourceType);
  // Older org-wide records do not identify an individual resource. Require
  // authority over the category's complete resource set, never create-only access.
  const group = findCategory(input.category)?.group;
  const resource = group ? categoryResource[group] : undefined;
  return resource ? read(resource, "*", true) : false;
}

export function canReceiveNotification(userId: string, organizationId: string, input: { category: string; payload: unknown }) {
  return canReadNotification(buildBackgroundContext({ userId, organizationId, role: "restricted", label: "notification" }), input);
}
