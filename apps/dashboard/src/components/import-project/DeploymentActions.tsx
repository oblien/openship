"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DismissiblePopover } from "@/components/ui/Popover";
import { useI18n } from "@/components/i18n-provider";
import { useDeployment } from "@/context/DeploymentContext";
import { usePlatform } from "@/context/PlatformContext";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { encodeLocalSlug, encodeProjectSlug, encodeRepoSlug } from "@/utils/repoSlug";
import { getDeploymentSites, type DeploymentSite } from "./deployment-sites";

function OpenDeploymentSite({ sites }: { sites: DeploymentSite[] }) {
  const { t } = useI18n();
  const copy = t.importProject.deploymentProcessing;
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  if (sites.length === 0) return null;
  if (sites.length === 1) {
    return (
      <Button asChild className="grow sm:grow-0">
        <a href={`https://${sites[0].hostname}`} target="_blank" rel="noopener noreferrer">
          {copy.openSite}
          <UiIcon name="arrow-up-right" className="size-3.5" />
        </a>
      </Button>
    );
  }

  return (
    <DismissiblePopover open={open} onOpenChange={setOpen} className="relative grow sm:grow-0">
      <Button
        ref={triggerRef}
        type="button"
        className="w-full sm:w-auto"
        aria-label={copy.openSite}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {copy.openSite}
        <span aria-hidden className="tabular-nums">
          {sites.length}
        </span>
        <UiIcon name="chevron-down" />
      </Button>
      {open && (
        <nav
          id={listId}
          aria-label={copy.detailDomains}
          className="absolute end-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl bg-popover p-2 shadow-[var(--th-dropdown-shadow)]"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          <ul className="max-h-72 overflow-y-auto">
            {sites.map((site) => (
              <li key={site.hostname}>
                <a
                  href={`https://${site.hostname}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-all font-medium text-foreground">
                      {site.hostname}
                    </span>
                    {site.serviceNames.length > 0 && (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {site.serviceNames.join(" · ")}
                      </span>
                    )}
                  </span>
                  <UiIcon
                    name="arrow-up-right"
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </DismissiblePopover>
  );
}

/** One action owner for both build views; a retry remains busy until its request settles. */
export function DeploymentActions({
  onRedeploy,
}: {
  onRedeploy: () => void | Promise<string | null>;
}) {
  const { config, state, deploymentStatus, stopDeployment } = useDeployment();
  const { baseDomain } = usePlatform();
  const { t } = useI18n();
  const router = useRouter();
  const copy = t.importProject.deploymentProcessing;
  const [redeploying, setRedeploying] = useState(false);
  const retryInFlight = useRef(false);
  const projectId = state.projectId || config.projectId;
  const working = deploymentStatus === "building" || deploymentStatus === "deploying";
  const sites =
    deploymentStatus === "ready"
      ? getDeploymentSites(config, state.serviceStatuses, baseDomain)
      : [];

  const retry = async () => {
    if (retryInFlight.current) return;
    retryInFlight.current = true;
    setRedeploying(true);
    try {
      await onRedeploy();
    } finally {
      retryInFlight.current = false;
      setRedeploying(false);
    }
  };
  const openProject = () => {
    if (!projectId) return;
    invalidateProjectCaches(projectId);
    router.push(`/projects/${projectId}`);
  };

  return (
    <div className="flex w-full flex-wrap items-center gap-2 sm:ms-auto sm:w-auto sm:justify-end">
      {working || state.cancellationPending ? (
        <Button
          type="button"
          variant="secondary"
          className="w-full text-danger sm:w-auto"
          onClick={stopDeployment}
          disabled={state.isStopping || state.cancellationPending}
        >
          {state.isStopping || state.cancellationPending ? (
            <UiIcon name="spinner" className="animate-spin" />
          ) : (
            <UiIcon name="square" />
          )}
          {state.isStopping || state.cancellationPending ? copy.stopping : copy.stopDeployment}
        </Button>
      ) : (
        <>
          <Button
            type="button"
            variant={deploymentStatus === "ready" && sites.length === 0 ? "default" : "secondary"}
            className="grow sm:grow-0"
            onClick={openProject}
            disabled={!projectId}
          >
            {copy.openProject}
            <UiIcon name="arrow-right" className="rtl:rotate-180" />
          </Button>
          {deploymentStatus === "ready" ? (
            <OpenDeploymentSite sites={sites} />
          ) : (
            <Button
              type="button"
              className="w-full sm:w-auto"
              disabled={redeploying}
              onClick={retry}
            >
              {redeploying ? (
                <UiIcon name="spinner" className="animate-spin" />
              ) : (
                <UiIcon name="rotate-left" />
              )}
              {redeploying ? copy.redeploying : copy.redeploy}
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export function DeploymentConfigurationAction({ className }: { className?: string }) {
  const { config, state } = useDeployment();
  const { t } = useI18n();
  const projectId = state.projectId || config.projectId;
  if (!projectId) return null;

  const slug = config.localPath
    ? encodeLocalSlug(config.localPath)
    : config.owner && config.repo
      ? encodeRepoSlug(config.owner, config.repo)
      : encodeProjectSlug(projectId);
  const params = new URLSearchParams({ projectId, mode: "config" });

  return (
    <Button asChild variant="ghost" className={className}>
      <Link href={`/deploy/${slug}?${params.toString()}`}>
        <UiIcon name="sliders" />
        {t.importProject.composeDeployment.editConfiguration}
      </Link>
    </Button>
  );
}
