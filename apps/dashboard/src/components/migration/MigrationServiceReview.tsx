"use client";

import { useId, useMemo, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { ServiceIcon } from "@/components/services/ServiceIcon";
import PublicEndpointsCard from "@/components/routing/PublicEndpointsCard";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { resolvePublicEndpointHostname } from "@/lib/public-endpoint-payload";
import { dockerMigrationApi, type DiscoveredService } from "@/lib/api/server-migration";
import type { PublicEndpoint } from "@/context/deployment/types";
import {
  editableServiceRoutes,
  firstContainerPort,
  hasIncompleteServiceRoutes,
  keptServiceRoutes,
  type RouteMode,
} from "./migration-route-input";

export type DeployAction = "reuse" | "build" | "pull";
export type VolumeStrategy = "reuse" | "copy";

interface MigrationServiceReviewProps {
  service: DiscoveredService;
  sourceServerId: string | null;
  routes: PublicEndpoint[] | undefined;
  envOverride: Record<string, string> | undefined;
  sameServer: boolean;
  volumeStrategy: VolumeStrategy | undefined;
  routeMode: RouteMode;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  isNew?: boolean;
  deployAction?: DeployAction;
  onSetRoutes: (routes: PublicEndpoint[]) => void;
  onSetEnv: (env: Record<string, string>) => void;
  onSetStrategy: (strategy: VolumeStrategy) => void;
  onSetRouteMode: (mode: RouteMode) => void;
}

/** A compact review of detected configuration; editing uses the native service controls. */
export function MigrationServiceReview({
  service,
  sourceServerId,
  routes,
  envOverride,
  sameServer,
  volumeStrategy,
  routeMode,
  expanded,
  onExpandedChange,
  isNew = false,
  deployAction = "reuse",
  onSetRoutes,
  onSetEnv,
  onSetStrategy,
  onSetRouteMode,
}: MigrationServiceReviewProps) {
  const { t } = useI18n();
  const { baseDomain } = usePlatform();
  const s = t.migration.wizard.steps;
  const d = t.migration.discover;
  const r = t.migration.review;
  const routingLabels = t.widgets.routing.settingsCard;
  const [envModalOpen, setEnvModalOpen] = useState(false);
  const [imageEnvOpen, setImageEnvOpen] = useState(false);
  const [warningsOpen, setWarningsOpen] = useState(false);
  const detailsId = useId();
  const warningsId = useId();
  // Detected routes appear in Custom; opening the editor does not change the import plan.
  const inputRoutes = useMemo(
    () => (routeMode === "keep" ? keptServiceRoutes(service, firstContainerPort(service)) : routes),
    [routeMode, service, routes],
  );
  const port = inputRoutes?.[0]?.port ?? firstContainerPort(service);
  const visibleRoutes =
    routeMode === "none"
      ? []
      : (inputRoutes ?? []).map((route) => ({
          domain: resolvePublicEndpointHostname(route, baseDomain),
          path: route.targetPath,
          exact: route.exact,
          port: route.port,
        }));
  const firstRoute = visibleRoutes[0];
  const incomplete = hasIncompleteServiceRoutes(routeMode, inputRoutes);
  const volumes = service.volumes.filter((volume) => volume.type === "volume" && volume.source);
  const envRecord = envOverride ?? service.env;
  const envRows = useMemo(
    () => Object.entries(envRecord).map(([key, value]) => ({ key, value, visible: false })),
    [envRecord],
  );
  const pendingImageEnv = Object.entries(service.envImageDefaults ?? {}).filter(
    ([key]) => !(key in envRecord),
  );
  const onReveal = useMemo(() => {
    const containerId = service.containerId;
    if (!sourceServerId || !containerId) return undefined;
    return (keys: string[]) =>
      dockerMigrationApi
        .revealEnv({ serverId: sourceServerId, containerId, keys })
        .then((result) => result.environment);
  }, [sourceServerId, service.containerId]);
  const modes = ["custom", "free", "none"] as const;
  const selectedMode = routeMode === "keep" ? "custom" : routeMode;
  const modeLabels = {
    custom: routingLabels.custom,
    free: routingLabels.free,
    none: routingLabels.internalOnly,
  };
  const selectMode = (mode: (typeof modes)[number]) => {
    if (mode === selectedMode) return;
    if (mode === "free" || mode === "custom")
      onSetRoutes(editableServiceRoutes(service, inputRoutes, mode));
    onSetRouteMode(mode);
  };

  return (
    <section
      className="@container min-w-0 overflow-hidden rounded-2xl bg-card"
      aria-label={service.name}
    >
      <button
        type="button"
        onClick={() => onExpandedChange(!expanded)}
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={interpolate(r.configureService, { name: service.name })}
        className="flex w-full min-w-0 items-center gap-3 p-4 text-start transition-colors hover:bg-muted/30 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50">
          <ServiceIcon service={service} className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-semibold text-foreground" title={service.name}>
              {service.name}
            </span>
            {isNew && (
              <span className="text-xs text-info">
                {deployAction === "build" ? s.deployActionBuild : s.deployActionPull}
              </span>
            )}
          </span>
          <span
            className={`mt-1 flex min-w-0 items-center gap-1.5 text-sm ${incomplete ? "text-warning" : "text-muted-foreground"}`}
          >
            <Icon
              name={routeMode === "none" ? "lock" : incomplete ? "warning" : "globe"}
              className="size-3.5 shrink-0"
            />
            <span className="truncate" title={firstRoute?.domain}>
              {incomplete
                ? r.finishRoute
                : routeMode === "none"
                  ? r.internal
                  : `${firstRoute?.domain ?? ""}${firstRoute?.path && firstRoute.path !== "/" ? firstRoute.path : ""}`}
            </span>
            {visibleRoutes.length > 1 && (
              <span className="shrink-0 text-xs">+{visibleRoutes.length - 1}</span>
            )}
            {!incomplete && routeMode === "keep" && (
              <span className="hidden shrink-0 text-xs text-success @md:inline">{r.detected}</span>
            )}
          </span>
        </span>
        <span className="hidden shrink-0 text-xs text-muted-foreground @lg:block">
          {(firstRoute?.port || port) && `${d.ports} ${firstRoute?.port || port}`}
        </span>
        <Icon
          name="chevron-down"
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>

      {(volumes.length > 0 || envRows.length > 0 || service.warnings.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-4 text-xs text-muted-foreground">
          {volumes.length > 0 && (
            <button
              type="button"
              className="rounded-md hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => onExpandedChange(!expanded)}
              aria-expanded={expanded}
              aria-controls={detailsId}
            >
              {interpolate(d.nVolumes, { n: String(volumes.length) })} ·{" "}
              {sameServer && volumeStrategy !== "copy" ? d.volumeReuse : d.volumeCopy}
            </button>
          )}
          {envRows.length > 0 && (
            <button
              type="button"
              onClick={() => setEnvModalOpen(true)}
              className="rounded-md hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={`${s.envTitle} · ${service.name}`}
            >
              {interpolate(d.nEnv, { n: String(envRows.length) })}
            </button>
          )}
          {service.warnings.length > 0 && (
            <button
              type="button"
              onClick={() => setWarningsOpen((value) => !value)}
              aria-expanded={warningsOpen}
              aria-controls={warningsId}
              className="inline-flex items-center gap-1.5 rounded-md text-warning focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Icon name="warning" className="size-3.5" />
              {service.warnings.length === 1
                ? t.dashboard.home.oneIssue
                : interpolate(t.dashboard.home.manyIssues, { n: String(service.warnings.length) })}
            </button>
          )}
        </div>
      )}

      {warningsOpen && (
        <div
          id={warningsId}
          className="mx-4 mb-4 space-y-1 rounded-xl bg-warning-bg p-3 text-xs text-warning"
        >
          {service.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}

      {expanded && (
        <div id={detailsId} className="space-y-5 border-t border-border/50 p-4">
          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground">{r.routingTitle}</p>
            <div
              role="group"
              aria-label={s.routeTitle}
              className="flex w-fit max-w-full flex-wrap gap-1 rounded-xl bg-background p-1"
            >
              {modes.map((mode) => (
                <Button
                  key={mode}
                  variant={selectedMode === mode ? "default" : "ghost"}
                  size="sm"
                  aria-pressed={selectedMode === mode}
                  onClick={() => selectMode(mode)}
                >
                  {modeLabels[mode]}
                </Button>
              ))}
            </div>
            {routeMode === "none" && (
              <p className="text-xs text-muted-foreground">{s.internalOnly}</p>
            )}
            {selectedMode !== "none" && (
              <PublicEndpointsCard
                projectName={service.name}
                endpoints={inputRoutes ?? []}
                hasServer
                runtimePort={port}
                allowPortEdit
                saveMode="change"
                hideHeader
                hideTypeToggle
                portInline
                preserveProxyPaths
                onChange={(nextRoutes) => {
                  onSetRoutes(nextRoutes);
                  if (routeMode === "keep") onSetRouteMode("custom");
                }}
              />
            )}
            {incomplete && (
              <p role="status" className="text-xs text-warning">
                {r.finishRouteHint}
              </p>
            )}
          </div>

          {volumes.length > 0 && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-medium text-foreground">{d.volumesTitle}</p>
                {sameServer ? (
                  <div
                    role="group"
                    aria-label={d.volumesTitle}
                    className="flex gap-1 rounded-xl bg-background p-1"
                  >
                    {(["reuse", "copy"] as const).map((strategy) => (
                      <Button
                        key={strategy}
                        variant={(volumeStrategy ?? "reuse") === strategy ? "default" : "ghost"}
                        size="sm"
                        aria-pressed={(volumeStrategy ?? "reuse") === strategy}
                        onClick={() => onSetStrategy(strategy)}
                      >
                        {strategy === "reuse" ? d.volumeReuse : d.volumeCopy}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">{d.volumeCopy}</span>
                )}
              </div>
              <div className="space-y-1 text-xs text-muted-foreground">
                {volumes.map((volume, index) => (
                  <p key={`${volume.source}:${index}`} className="break-all">
                    {volume.source} <span aria-hidden="true">→</span> {volume.target}
                  </p>
                ))}
              </div>
              {sameServer && <p className="text-xs text-muted-foreground">{d.volumeCopyHint}</p>}
            </div>
          )}

          {envRows.length === 0 && (
            <Button
              variant="outline"
              className="w-full justify-between"
              onClick={() => setEnvModalOpen(true)}
              aria-label={`${s.envTitle} · ${service.name}`}
            >
              {s.envTitle}
              <Icon name="chevron-right" className="rtl:rotate-180" />
            </Button>
          )}
          <div className="flex min-w-0 items-start gap-3 text-xs text-muted-foreground">
            <span className="shrink-0">{service.build ? d.build : d.image}</span>
            <span className="min-w-0 break-all">{service.image ?? service.build}</span>
          </div>
          {pendingImageEnv.length > 0 && (
            <div className="rounded-xl bg-background p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setImageEnvOpen((value) => !value)}
                  aria-expanded={imageEnvOpen}
                  className="inline-flex min-w-0 items-center gap-1.5 rounded-md text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <Icon
                    name="chevron-down"
                    className={`size-3.5 shrink-0 ${imageEnvOpen ? "rotate-180" : ""}`}
                  />
                  {interpolate(d.envFromImage, { n: String(pendingImageEnv.length) })}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onSetEnv({ ...envRecord, ...Object.fromEntries(pendingImageEnv) })}
                >
                  {d.envFromImageImport}
                </Button>
              </div>
              {imageEnvOpen && (
                <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                  <p>{d.envFromImageHint}</p>
                  {pendingImageEnv.map(([key, value]) => (
                    <p key={key} className="break-all font-mono">
                      {key}={value}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <Modal
        isOpen={envModalOpen}
        onClose={() => setEnvModalOpen(false)}
        maxWidth="760px"
        maxHeight="86vh"
        overflow="hidden"
        showCloseButton={false}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border/50 px-5 py-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{service.name}</p>
            <p className="text-xs text-muted-foreground">
              {s.envTitle} · {envRows.length}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setEnvModalOpen(false)}
            aria-label={t.migration.wizard.close}
          >
            <Icon name="close" />
          </Button>
        </div>
        <div className="max-h-[calc(86vh-92px)] overflow-y-auto">
          <EnvironmentVariables
            mode="settings"
            borderless
            hideTitle
            envVars={envRows}
            onEnvVarsChange={(rows) =>
              onSetEnv(
                Object.fromEntries(
                  rows.filter((row) => row.key).map((row) => [row.key, row.value]),
                ),
              )
            }
            onReveal={onReveal}
          />
        </div>
      </Modal>
    </section>
  );
}
