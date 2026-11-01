import type { AuditContext, AuditEventInput } from "../../lib/audit-emitter";
import { cloudAnalytics } from "./index";
import type { NotificationEmitInput } from "../../lib/notification-dispatcher";

export function observeCloudNotification(input: NotificationEmitInput): void {
  if (!input.resourceId || !cloudAnalytics.enabled({ organizationId: input.organizationId }))
    return;
  if (input.eventType === "backup_run.succeeded") {
    const bytes = input.payload?.bytesTransferred;
    cloudAnalytics.capture(
      { organizationId: input.organizationId },
      "cloud_backup_completed",
      { backup_id: input.resourceId, ...(typeof bytes === "number" && bytes >= 0 && { bytes }) },
      `backup:${input.resourceId}:succeeded`,
    );
  } else if (input.eventType === "backup_run.failed") {
    cloudAnalytics.capture(
      { organizationId: input.organizationId },
      "cloud_backup_failed",
      { backup_id: input.resourceId },
      `backup:${input.resourceId}:failed`,
    );
  }
}

/** Explicit projection of existing shared lifecycle facts. Never forward the audit diff. */
export function observeCloudAudit(ctx: AuditContext, event: AuditEventInput): void {
  const actor = {
    organizationId: ctx.organizationId,
    userId: ctx.actorUserId,
    source: event.source ?? ctx.source ?? ("system" as const),
  };
  if (!cloudAnalytics.enabled(actor)) return;
  const resource = event.resourceId;
  if (!resource || resource === "*") return;
  const after =
    event.after && typeof event.after === "object" ? (event.after as Record<string, unknown>) : {};
  if (event.eventType === "project.created") {
    cloudAnalytics.capture(
      actor,
      "cloud_project_created",
      { project_id: resource },
      `project:${resource}`,
    );
  } else if (
    event.eventType === "deployment.succeeded" ||
    event.eventType === "deployment.failed"
  ) {
    if (typeof after.projectId !== "string") return;
    const properties = {
      project_id: after.projectId,
      deployment_id: resource,
      ...(typeof after.durationMs === "number" &&
        after.durationMs >= 0 && { duration_ms: after.durationMs }),
    };
    const succeeded = event.eventType === "deployment.succeeded";
    cloudAnalytics.deploymentOutcome(actor, succeeded, properties);
  } else if (
    event.eventType === "project.updated" &&
    (after.action === "cluster.target" || after.action === "cluster.replicas")
  ) {
    cloudAnalytics.capture(actor, "cloud_scaling_configured", {
      project_id: resource,
      action: after.action === "cluster.target" ? "target" : "replicas",
    });
  } else if (event.resourceType === "backup_policy" && after.operation === "create") {
    cloudAnalytics.capture(
      actor,
      "cloud_backup_policy_created",
      { policy_id: resource },
      `backup-policy:${resource}`,
    );
  } else if (
    event.eventType === "settings.updated" &&
    after.action === "cloneCredentials.set" &&
    after.asDefault === true
  ) {
    cloudAnalytics.capture(
      actor,
      "cloud_github_connected",
      { method: "token" },
      `github:${ctx.organizationId}:token:${ctx.actorUserId}`,
    );
  }
}
