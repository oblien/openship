"use client";

import type { CloudWorkspaceSummary } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { ServiceStatusIndicator } from "@/components/services/ServiceStatusBadge";

export function ManagedServerStatus({
  workspace,
  compact = false,
}: {
  workspace: CloudWorkspaceSummary;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const connectionIssue = workspace.connectionIssue;
  const operation = workspace.operation?.status;
  const state =
    operation === "failed"
      ? "failed"
      : operation === "queued" || operation === "running"
        ? operation === "queued"
          ? "queued"
          : "running_operation"
        : workspace.state;
  const healthy = !connectionIssue && ["ready", "running", "active"].includes(state);
  const failed = !connectionIssue && ["failed", "unreachable"].includes(state);
  const pending =
    !connectionIssue &&
    ["queued", "running_operation", "provisioning", "starting", "stopping", "deleting"].includes(
      state,
    );
  const label = connectionIssue
    ? t.servers.managedControls.cloudConnection.labels[connectionIssue]
    : ((t.billing.workspaces.states as Record<string, string>)[state] ?? state);

  return (
    <span
      role="status"
      title={compact ? label : undefined}
      className={
        compact
          ? "inline-flex shrink-0 items-center"
          : `inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium ${
              connectionIssue
                ? "bg-warning-bg text-warning"
                : failed
                  ? "bg-danger/10 text-danger"
                  : healthy
                    ? "bg-success-bg text-success"
                    : pending
                      ? "bg-info-bg text-info"
                      : "bg-muted/60 text-muted-foreground"
            }`
      }
    >
      <ServiceStatusIndicator
        status={failed ? "failed" : healthy ? "running" : pending ? "deploying" : "unknown"}
      />
      {compact ? <span className="sr-only">{label}</span> : label}
    </span>
  );
}
