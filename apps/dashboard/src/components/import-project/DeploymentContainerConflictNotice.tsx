"use client";

import Link from "next/link";
import { useDeployment } from "@/context/DeploymentContext";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

/** Use this attempt's recorded target, even after the project has moved. */
export function DeploymentContainerConflictNotice() {
  const { state, deploymentStatus } = useDeployment();
  const { t } = useI18n();
  if (
    deploymentStatus !== "failed" ||
    state.deploymentCanceled ||
    state.errorCode !== "SERVICE_CONTAINER_CONFLICT"
  )
    return null;
  const copy = t.deployments.containerConflict;
  const details = state.errorDetails;
  const names = Array.isArray(details?.containerNames)
    ? details.containerNames.filter((value): value is string => typeof value === "string")
    : [];
  const serverId = typeof details?.serverId === "string" && details.serverId;
  const workspaceId = typeof details?.workspaceId === "string" && details.workspaceId;
  const targetHref = serverId
    ? `/servers/${encodeURIComponent(serverId)}`
    : workspaceId
      ? `/resources?pool=${encodeURIComponent(workspaceId)}`
      : null;

  return (
    <section aria-label={copy.title} className="rounded-2xl bg-card p-5">
      <h2 className="text-sm font-medium text-foreground">{copy.title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
      {names.length > 0 && (
        <ul aria-label={copy.containers} className="mt-3 space-y-1 text-sm text-muted-foreground">
          {names.map((name, index) => (
            <li key={`${index}:${name}`}>
              <code className="break-all">{name}</code>
            </li>
          ))}
        </ul>
      )}
      {state.deploymentId && (
        <p className="mt-3 break-all text-xs text-muted-foreground">
          {copy.reference}: <code>{state.deploymentId}</code>
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {targetHref && (
          <Button asChild variant="secondary" size="sm">
            <Link href={targetHref}>{copy.reviewServer}</Link>
          </Button>
        )}
        <Button asChild variant="secondary" size="sm">
          <Link href="/support">{t.projects.help.contactSupport}</Link>
        </Button>
      </div>
    </section>
  );
}
