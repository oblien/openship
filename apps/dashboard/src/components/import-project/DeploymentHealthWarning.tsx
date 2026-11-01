"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { SERVICE_STARTING_HEALTH_WARNING } from "@repo/core";
import { Icon as UiIcon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { ServiceStatusBadge } from "@/components/services/ServiceStatusBadge";
import { getApiErrorMessage, projectsApi, servicesApi, type ServiceContainer } from "@/lib/api";
import { getActiveOrganizationId } from "@/lib/api/client";

/** Historical deployment warnings stay intact. Only a reported healthy check
 * on the same active deployment can resolve a startup-health advisory. */
export function DeploymentHealthWarning({
  projectId,
  deploymentId,
  warningMessage,
  onResolved,
}: {
  projectId?: string | null;
  deploymentId?: string | null;
  warningMessage: string;
  onResolved: (resolved: boolean) => void;
}) {
  const { t } = useI18n();
  const copy = t.importProject.deploymentHealth;
  const [containers, setContainers] = useState<ServiceContainer[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);
  const controls = useRef<{ check: () => void } | null>(null);
  const resolve = useRef(onResolved);
  resolve.current = onResolved;

  useEffect(() => {
    if (!projectId || !deploymentId) return;
    let disposed = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const organizationId = getActiveOrganizationId();
    const current = () => !disposed && organizationId === getActiveOrganizationId();
    let deadline = Date.now() + 60_000;
    const check = async () => {
      if (!current() || reading) return;
      reading = true;
      clearTimeout(timer);
      setChecking(true);
      setError(null);
      try {
        const before = await projectsApi.getInfo(projectId);
        if (!current()) return;
        if (before.data?.project?.activeDeploymentId !== deploymentId)
          throw new Error(copy.historical);
        const result = await servicesApi.containers(projectId);
        if (!current()) return;
        // A redeploy may replace the active stack during the runtime read.
        const after = await projectsApi.getInfo(projectId);
        if (!current()) return;
        if (after.data?.project?.activeDeploymentId !== deploymentId)
          throw new Error(copy.historical);
        const rows = result.containers;
        if (rows.length === 0 || rows.some((row) => row.status === "unknown"))
          throw new Error(copy.unavailable);
        setContainers(rows);
        const recovered =
          rows.every((row) => row.containerId && row.status === "running") &&
          warningMessage
            .split("; ")
            .every((warning) =>
              rows.some(
                (row) =>
                  warning === `${row.serviceName}: ${SERVICE_STARTING_HEALTH_WARNING}` &&
                  row.containerId &&
                  row.status === "running" &&
                  row.health === "healthy",
              ),
            );
        setResolved(recovered);
        resolve.current(recovered);
        // Follow a starting stack briefly, only on this visible page. A failed
        // read stops polling and exposes Retry; never start an organization scan.
        if (
          !recovered &&
          rows.some((row) => row.status === "starting") &&
          Date.now() < deadline &&
          document.visibilityState !== "hidden"
        ) {
          timer = setTimeout(() => {
            if (document.visibilityState !== "hidden") void check();
          }, 5000);
        }
      } catch (failure) {
        if (!current()) return;
        setResolved(false);
        setContainers(null);
        resolve.current(false);
        setError(getApiErrorMessage(failure, copy.unavailable));
      } finally {
        reading = false;
        if (!disposed) setChecking(false);
      }
    };
    controls.current = {
      check: () => {
        deadline = Date.now() + 60_000;
        void check();
      },
    };
    void check();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controls.current = null;
    };
  }, [projectId, deploymentId, warningMessage, copy.historical, copy.unavailable]);

  return (
    <div className={`rounded-2xl px-5 py-4 ${resolved ? "bg-success-bg" : "bg-warning-bg"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          role="status"
          className={`text-sm font-medium ${resolved ? "text-success" : "text-warning"}`}
        >
          {resolved ? copy.healthy : t.importProject.composeDeployment.warningTitle}
        </p>
        {projectId && deploymentId && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={checking}
            onClick={() => controls.current?.check()}
          >
            <UiIcon
              name={checking ? "spinner" : "refresh"}
              className={checking ? "animate-spin" : ""}
            />
            {checking ? copy.checking : copy.recheck}
          </Button>
        )}
      </div>
      {resolved ? (
        <details className="mt-2 text-sm text-muted-foreground">
          <summary className="cursor-pointer">{copy.atDeployment}</summary>
          <p className="mt-1 break-words">{warningMessage}</p>
        </details>
      ) : (
        <p className="mt-2 break-words text-sm text-warning">{warningMessage}</p>
      )}
      {containers && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2" aria-label={copy.currentHealth}>
          {containers.map((row) => (
            <span key={row.serviceId} className="inline-flex min-w-0 items-center gap-2 text-sm">
              <span className="truncate">{row.serviceName}</span>
              <ServiceStatusBadge status={row.status} />
            </span>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      {!resolved && <p className="mt-3 text-sm text-muted-foreground">{copy.startupHint}</p>}
      {projectId && (
        <Link
          href={`/projects/${projectId}/logs`}
          className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:underline"
        >
          <UiIcon name="terminal" className="size-4" />
          {copy.viewLogs}
        </Link>
      )}
    </div>
  );
}
