"use client";

import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { ServiceStatusBadge, ServiceStatusIndicator } from "./ServiceStatusBadge";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useRuntimeRoles } from "@/hooks/useRuntimeRoles";
import { roleLogsHref, runtimeRoleState, type RuntimeRole } from "@/lib/runtime-roles";

export function RuntimeRoleReplicas({
  projectId,
  deploymentId,
  role,
  onNavigate,
}: {
  projectId: string;
  deploymentId: string;
  role: RuntimeRole;
  onNavigate?: (href: string) => void;
}) {
  const { t } = useI18n();
  const c = t.projectDetail.runtimeRoles;
  return (
    <ul className="divide-y divide-border/40">
      {role.containers.map((replica) => (
        <li
          key={replica.replica}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 text-xs"
        >
          <span className="flex-1 whitespace-nowrap font-medium text-foreground">
            {interpolate(c.replica, { replica: String(replica.replica) })}
          </span>
          {replica.status === "missing" ? (
            <span className="flex items-center gap-1.5 text-danger">
              <ServiceStatusIndicator status="failed" />
              {c.missing}
            </span>
          ) : (
            <ServiceStatusBadge status={replica.status} />
          )}
          {replica.restartCount !== null && (
            <span className="text-muted-foreground tabular-nums">
              {interpolate(c.restarts, { count: String(replica.restartCount) })}
            </span>
          )}
          {replica.containerId && (
            <Button asChild size="sm" variant="ghost" className="h-8">
              <Link
                href={roleLogsHref(projectId, deploymentId, role.name, replica.replica)}
                onClick={(event) => {
                  if (
                    onNavigate &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey
                  ) {
                    event.preventDefault();
                    onNavigate(roleLogsHref(projectId, deploymentId, role.name, replica.replica));
                  }
                }}
              >
                <Icon name="terminal" />
                {c.logs}
                <span className="sr-only">
                  {" "}
                  {role.name}, {interpolate(c.replica, { replica: String(replica.replica) })}
                </span>
              </Link>
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function RuntimeRolesCard({
  projectId,
  deploymentId,
}: {
  projectId: string;
  deploymentId?: string | null;
}) {
  const runtime = useRuntimeRoles(projectId, deploymentId);
  const { t } = useI18n();
  const c = t.projectDetail.runtimeRoles;
  if (!runtime.roles.length && !runtime.error && !runtime.loading) return null;
  return (
    <section aria-label={c.title} className="space-y-4 rounded-2xl bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">{c.title}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => void runtime.refresh()}
          disabled={runtime.loading}
          aria-label={c.retry}
        >
          <Icon name="refresh" className={runtime.loading ? "animate-spin" : undefined} />
        </Button>
      </div>
      {runtime.error && (
        <div role="alert" className="rounded-xl bg-warning-bg p-3 text-xs text-warning">
          <p>{runtime.error}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void runtime.refresh()}
            disabled={runtime.loading}
          >
            {c.retry}
          </Button>
        </div>
      )}
      {runtime.loading && !runtime.roles.length && (
        <p role="status" className="text-xs text-muted-foreground">
          {c.checking}
        </p>
      )}
      {runtime.roles.map((role) => (
        <div key={role.name} className="rounded-xl bg-card px-4 pt-3">
          <div className="flex items-center gap-3 pb-1">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground">
              <Icon name={role.kind === "scheduler" ? "clock" : "terminal"} className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h3
                className="truncate text-sm font-medium text-foreground"
                dir="auto"
                title={role.name}
              >
                {role.name}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {role.kind ? c[role.kind] : c.kind} ·{" "}
                {interpolate(role.replicas === 1 ? c.replicaOne : c.replicas, {
                  count: String(role.replicas),
                })}
              </p>
            </div>
            <ServiceStatusBadge
              status={runtimeRoleState(role) === "missing" ? "failed" : runtimeRoleState(role)}
            />
          </div>
          {runtime.deploymentId && (
            <RuntimeRoleReplicas
              projectId={projectId}
              deploymentId={runtime.deploymentId}
              role={role}
            />
          )}
        </div>
      ))}
    </section>
  );
}
