"use client";

import Link from "next/link";
import { useDeployment } from "@/context/DeploymentContext";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

/** Recovery uses this attempt's image, including after a configuration change. */
export function DeploymentRegistryAccessNotice() {
  const { state, deploymentStatus } = useDeployment();
  const { t } = useI18n();
  if (
    deploymentStatus !== "failed" ||
    state.deploymentCanceled ||
    state.errorCode !== "REGISTRY_ACCESS_DENIED"
  ) return null;

  const copy = t.deployments.registryAccess;
  const image = typeof state.errorDetails?.imageRef === "string" ? state.errorDetails.imageRef : null;
  const registry = typeof state.errorDetails?.registry === "string" ? state.errorDetails.registry : null;
  return (
    <section aria-label={copy.title} className="rounded-2xl bg-card p-5">
      <h2 className="text-sm font-medium text-foreground">{copy.title}</h2>
      {image && <p className="mt-2 break-all font-mono text-xs text-foreground">{image}</p>}
      <p className="mt-2 text-sm text-muted-foreground">{copy.description}</p>
      {registry === "ghcr.io" && <p className="mt-1 text-sm text-muted-foreground">{copy.githubHint}</p>}
      <p className="mt-1 text-sm text-muted-foreground">{copy.retryHint}</p>
      <Button asChild variant="secondary" size="sm" className="mt-3">
        <Link href="/settings?tab=connections#docker-registry">{copy.manageAccess}</Link>
      </Button>
    </section>
  );
}
