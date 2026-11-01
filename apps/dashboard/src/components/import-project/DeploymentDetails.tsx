"use client";

import { memo, type ReactNode } from "react";
import { Icon as UiIcon, type IconName } from "@repo/ui/icons";
import { useDeployment } from "@/context/DeploymentContext";
import { composeServiceTally, usesServiceDeployment } from "@/context/deployment/types";
import { useBuildElapsedMs } from "@/context/deployment/useBuildElapsedMs";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { describeBuildStrategy } from "./deploy-target-label";
import { DeployTargetValue } from "./DeployTargetValue";
import { getDeploymentSites } from "./deployment-sites";
import { DeploymentConfigurationAction } from "./DeploymentActions";

function DetailRow({
  icon,
  label,
  children,
}: {
  icon: IconName;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <dt className="inline-flex shrink-0 items-center gap-2 text-muted-foreground">
        <UiIcon name={icon} className="size-4" aria-hidden />
        {label}
      </dt>
      <dd className="min-w-0 break-words text-end text-foreground">{children}</dd>
    </div>
  );
}

// Only the duration label ticks; the surrounding details stay still.
const BuildTime = memo(function BuildTime() {
  const { state } = useDeployment();
  const elapsedMs = useBuildElapsedMs(state);
  if (elapsedMs === null) return <>—</>;
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  return (
    <span className="tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
    </span>
  );
});

/** One details layout for single-service and Compose deployments. */
function DeploymentDetails() {
  const { state, config, deploymentStatus } = useDeployment();
  const { baseDomain } = usePlatform();
  const { t } = useI18n();
  const copy = t.importProject.deploymentProcessing;
  const serviceDeployment = usesServiceDeployment(config);
  const tally = t.importProject.composeServiceTally;
  const { running, built, building, failed } = composeServiceTally(state.serviceStatuses);
  const total = Math.max(config.services.length, state.serviceStatuses.length);
  const sites = getDeploymentSites(config, state.serviceStatuses, baseDomain);
  const canConfigure =
    ["ready", "failed", "cancelled"].includes(deploymentStatus) &&
    !state.cancellationPending &&
    !!(state.projectId || config.projectId);

  return (
    <section aria-label={copy.detailsTitle} className="rounded-2xl bg-card p-5">
      <h2 className="text-sm font-semibold text-foreground">{copy.detailsTitle}</h2>
      <dl className="mt-5 space-y-4">
        <DetailRow
          icon={config.deployTarget === "cloud" ? "cloud" : "server"}
          label={copy.detailInstance}
        >
          <DeployTargetValue config={config} />
        </DetailRow>
        <DetailRow icon="wrench" label={copy.detailBuild}>
          {describeBuildStrategy(config, t)}
        </DetailRow>
        <DetailRow icon="clock" label={copy.detailBuildTime}>
          <BuildTime />
        </DetailRow>
        {serviceDeployment ? (
          <>
            {total > 0 && (
              <DetailRow icon="layers" label={t.importProject.composeSidebar.rowServices}>
                <span className="inline-block tabular-nums">
                  {running}/{total} {tally.running}
                  {built > 0 && (
                    <span className="ms-1">
                      {interpolate(tally.builtSuffix, { count: String(built) })}
                    </span>
                  )}
                  {building > 0 && (
                    <span className="ms-1">
                      {interpolate(tally.buildingSuffix, { count: String(building) })}
                    </span>
                  )}
                  {failed > 0 && (
                    <span className="ms-1 text-danger">
                      {interpolate(tally.failedSuffix, { count: String(failed) })}
                    </span>
                  )}
                </span>
              </DetailRow>
            )}
            <DetailRow icon="docker" label={t.importProject.composeSidebar.rowType}>
              Compose
            </DetailRow>
          </>
        ) : (
          <>
            <DetailRow icon="layers" label={copy.detailFramework}>
              {config.framework || "—"}
            </DetailRow>
            <DetailRow
              icon="globe"
              label={sites.length > 1 ? copy.detailDomains : copy.detailDomain}
            >
              {sites.length
                ? sites.map((site) => (
                    <span key={site.hostname} className="block truncate" title={site.hostname}>
                      {site.hostname}
                    </span>
                  ))
                : "—"}
            </DetailRow>
          </>
        )}
      </dl>
      {canConfigure && (
        <div className="mt-5 border-t border-border/40 pt-3">
          <DeploymentConfigurationAction className="w-full justify-start" />
        </div>
      )}
    </section>
  );
}

export default memo(DeploymentDetails);
