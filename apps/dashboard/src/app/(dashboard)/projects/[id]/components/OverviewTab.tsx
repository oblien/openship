"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

import React from "react";
import Link from "next/link";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { workloadOf } from "@/context/deployment/types";
import { AnalyticsError } from "@/components/monitoring/AnalyticsError";
import { ServiceIcon } from "@/components/services/ServiceIcon";
import { ConnectionCard } from "./ConnectionCard";
import { ConnectedServicesCard } from "./ConnectedServicesCard";
import { UsedByCard } from "./UsedByCard";
import { TrafficChart } from "./general/TrafficChart";
import { useProjectInfo, useAnalyticsData, invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { gitSourceHref, gitSourceLabel } from "@/utils/repoSlug";
import type { Dictionary } from "@/i18n";

export const OverviewTab = () => {
  const {
    projectData,
    buildData,
    setActiveTab,
    id,
    servicesData,
    selectedDomain,
    domain,
    domainsData,
  } = useProjectSettings();
  const { t } = useI18n();

  // Analytics are traffic-to-a-domain — with no assigned domain the whole
  // section stays empty (a port-only app / DB has no hostname to log). Hide it
  // until a domain exists rather than show empty charts.
  const hasDomain =
    !!(selectedDomain || domain) || (domainsData?.domains?.length ?? 0) > 0;

  // Project info and analytics load independently. Analytics share one
  // project-wide request and cache with Monitoring's default All scope.
  const projectInfoQuery = useProjectInfo(id);
  const analytics = useAnalyticsData(projectData.id === id && hasDomain ? id : null);
  const showAnalyticsError = !!analytics.error && !analytics.isLoading;
  const analyticsData = analytics.data;
  const services = servicesData.services;
  const serviceCount = servicesData.isLoading
    ? (projectData.serviceCount ?? services.length)
    : services.length;

  // deployTarget comes from API (active deployment's meta), not from global dashboard mode
  const deployTarget = projectData.deployTarget as string | null;
  const platformLabel =
    deployTarget === "cloud"
      ? t.projects.overview.platformCloud
      : deployTarget === "server"
        ? t.projects.overview.platformServer
        : deployTarget === "local"
          ? t.projects.overview.platformLocal
          : "-";
  const hasGit = !!(projectData.gitOwner && projectData.gitRepo);
  // A worker shares hasServer=false with a static site, so classify via the
  // resolved workload — otherwise a worker mislabels as "Static" (#538).
  const workload = workloadOf({
    workloadType: projectData.workloadType ?? projectData.options?.workloadType,
    hasServer: projectData.hasServer ?? projectData.options?.hasServer,
  });
  const modeLabel =
    workload === "static"
      ? t.projects.overview.modeStatic
      : workload === "worker"
        ? t.projects.overview.modeWorker
        : projectData.productionMode === "standalone"
          ? t.projects.overview.modeStandalone
          : t.projects.overview.modeServer;

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num?.toString() || "0";
  };

  // Summary and chart come from the same snapshot; info has its own load.
  const showProjectInfoSkeleton = projectInfoQuery.isLoading;
  const showStatsSkeleton = analytics.isLoadingSummary;
  const showChartSkeleton = analytics.isLoadingPeriods;
  type Stat = {
    label: string;
    value: string;
    icon: React.ReactNode;
    subtext?: string;
    loading?: boolean;
  };
  const stats: Stat[] = showStatsSkeleton
    ? [
        {
          label: t.projects.stats.serverRequests,
          value: "",
          icon: <UiIcon name="server" className="size-4" />,
          loading: true,
        },
        {
          label: t.projects.stats.uniqueIPs,
          value: "",
          icon: <UiIcon name="users" className="size-4" />,
          loading: true,
        },
        {
          label: t.projects.stats.avgResponse,
          value: "",
          icon: <UiIcon name="gauge" className="size-4" />,
          loading: true,
        },
        {
          label: t.projects.stats.bandwidthOut,
          value: "",
          icon: <UiIcon name="arrows-up-down" className="size-4" />,
          loading: true,
        },
      ]
    : [
        {
          label: t.projects.stats.serverRequests,
          value: formatNumber(analyticsData?.summary?.totalRequests ?? 0),
          icon: <UiIcon name="server" className="size-4" />,
          subtext: interpolate(t.projects.stats.requestsSubtext, {
            total: formatNumber(analyticsData?.summary?.totalRequests ?? 0),
            avg: String(analyticsData?.summary?.avgRequestsPerHour ?? 0),
          }),
        },
        {
          label: t.projects.stats.uniqueIPs,
          value: formatNumber(analyticsData?.summary?.uniqueIPs ?? 0),
          icon: <UiIcon name="users" className="size-4" />,
          subtext: interpolate(t.projects.stats.uniqueIPsSubtext, {
            pct: String(analyticsData?.summary?.uniqueIPsPercentage ?? 0),
          }),
        },
        {
          label: t.projects.stats.avgResponse,
          value: `${analyticsData?.performance?.avgResponseTimeMs?.toFixed(2) || "N/A "}ms`,
          icon: <UiIcon name="gauge" className="size-4" />,
          subtext: t.projects.stats.responseTime,
        },
        {
          label: t.projects.stats.bandwidthOut,
          value: analyticsData?.bandwidth?.totalOutFormatted || "N/A",
          icon: <UiIcon name="arrows-up-down" className="size-4" />,
          subtext: interpolate(t.projects.stats.bandwidthInSubtext, {
            value: analyticsData?.bandwidth?.totalInFormatted ?? "0 B",
          }),
        },
      ];

  const trafficData = analyticsData?.trafficByHour || [];
  const topPaths = analyticsData?.topPaths || [];

  return (
    <div className="space-y-5">
      {/* Apps expose their connection details first. Projects share individual
          services from the Services tab. */}
      {projectData.id && projectData.isApp && (
        <ConnectionCard
          projectId={projectData.id}
          appTemplateId={projectData.appTemplateId}
          serverId={projectData.serverId}
          deployTarget={deployTarget}
        />
      )}

      {/* Databases/apps wired INTO this project (renders nothing when none). */}
      {projectData.id && <ConnectedServicesCard projectId={projectData.id} />}

      {/* …and the mirror: projects consuming THIS one. A shared database backs many
          apps, so its own page has to show what depends on it. */}
      {projectData.id && <UsedByCard projectId={projectData.id} />}

      {/* ── Info sections ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Infrastructure */}
        <Card title={t.projects.overview.infrastructure} icon={"cpu"} iconColor="primary">
          <Item
            label={t.projects.overview.platform}
            value={platformLabel}
            loading={showProjectInfoSkeleton}
          />
          <Item
            label={t.projects.overview.mode}
            value={modeLabel}
            loading={showProjectInfoSkeleton}
          />
          {/* project.port belongs to the single-app runtime. Service projects
              own their ports per service; showing this fallback for an adopted
              stack contradicts its actual routing (#506). */}
          {serviceCount === 0 && (showProjectInfoSkeleton || workload === "web") && (
            <Item
              label={t.projects.overview.port}
              value={String(projectData.port || 3000)}
              loading={showProjectInfoSkeleton}
            />
          )}
          {/* Which self-hosted server this runs on — links to the server page. */}
          {deployTarget === "server" && (showProjectInfoSkeleton || projectData.serverName) && (
            <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <span className="text-[13px] text-muted-foreground">
                {t.projects.overview.server}
              </span>
              {showProjectInfoSkeleton ? (
                <div className="h-[14px] w-24 rounded bg-muted-foreground/20 animate-pulse" />
              ) : projectData.serverId ? (
                <Link
                  href={`/servers/${projectData.serverId}`}
                  className="inline-flex min-w-0 items-center gap-1.5 truncate text-[13px] font-medium text-foreground transition-colors hover:text-primary sm:max-w-[180px]"
                >
                  <span className="truncate">{projectData.serverName}</span>
                  <UiIcon name="arrow-up-right" className="size-3 shrink-0 text-muted-foreground" />
                </Link>
              ) : (
                <span className="min-w-0 truncate text-[13px] font-medium text-foreground sm:max-w-[180px]">
                  {projectData.serverName}
                </span>
              )}
            </div>
          )}
        </Card>

        {/* Source & CI/CD */}
        <Card title={t.projects.overview.sourceCicd} icon={"git-branch"} iconColor="orange">
          <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-[13px] text-muted-foreground">
              {t.projects.overview.repository}
            </span>
            {showProjectInfoSkeleton ? (
              <div className="h-[14px] w-28 rounded bg-muted-foreground/20 animate-pulse" />
            ) : hasGit ? (() => {
              const href = gitSourceHref({
                provider: projectData.gitProvider,
                owner: projectData.gitOwner,
                repo: projectData.gitRepo,
                project: projectData.gitProject,
              });
              const label = gitSourceLabel({
                provider: projectData.gitProvider,
                owner: projectData.gitOwner,
                repo: projectData.gitRepo,
                project: projectData.gitProject,
              });
              return href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] font-medium text-foreground hover:text-primary transition-colors inline-flex min-w-0 items-center gap-1.5 truncate sm:max-w-[180px]"
              >
                <span className="truncate">{label}</span>
                <UiIcon name="arrow-up-right" className="size-3 shrink-0 text-muted-foreground" />
              </a>
              ) : (
                <span className="text-[13px] font-medium text-foreground truncate max-w-[180px]">
                  {label}
                </span>
              );
            })() : (
              <span className="text-[13px] text-muted-foreground/60">
                {t.projects.overview.notConnected}
              </span>
            )}
          </div>
          <Item
            label={t.projects.overview.branch}
            value={projectData.gitBranch || projectData.branch || "main"}
            loading={showProjectInfoSkeleton}
          />
          {/* Both read the /info payload, NOT the Source tab's `gitData`: that
              slice is fetched only when GitSettings mounts (it also pulls recent
              commits from GitHub), so on a cold load straight to Overview it was
              undefined — and every project whose pushes really do deploy rendered
              "auto-deploy off". `autoDeploy` is the column webhook-push.ts gates
              on, so this row now shows what actually governs a push. */}
          <StatusItem
            label={t.projects.overview.autoDeploy}
            active={!!projectData.autoDeploy}
            loading={showProjectInfoSkeleton}
            t={t}
          />
          <StatusItem
            label={t.projects.overview.webhook}
            active={!!projectData.webhookActive}
            loading={showProjectInfoSkeleton}
            t={t}
          />
        </Card>
      </div>

      {/* ── Monitoring (only with a domain — no domain ⇒ no traffic) ── */}
      {hasDomain && showAnalyticsError && (
        <AnalyticsError error={analytics.error!} onRetry={() => invalidateProjectCaches(id)} />
      )}
      {hasDomain && !showAnalyticsError && (
        <>
      {/* Compact stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="bg-card rounded-xl border border-border/50 px-3.5 py-3">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-primary [&>svg]:size-3.5">{s.icon}</span>
              <span className="text-[11px] text-muted-foreground font-medium">{s.label}</span>
            </div>
            {s.loading ? (
              <>
                {/* Skeleton bars roughly matching the value (large) and
                    subtext (small) line heights so the card doesn't
                    visibly jump when the data lands. Tuned to
                    `bg-muted-foreground/*` instead of `bg-muted/*` -
                    the latter is nearly identical to the card surface
                    in this theme and renders almost invisible. */}
                <div className="h-[18px] w-12 rounded bg-muted-foreground/25 animate-pulse" />
                <div className="h-[10px] w-20 mt-1.5 rounded bg-muted-foreground/15 animate-pulse" />
              </>
            ) : (
              <>
                <p className="text-[18px] font-semibold text-foreground leading-tight">{s.value}</p>
                {s.subtext && (
                  <p className="text-[10px] text-muted-foreground/60 mt-0.5">{s.subtext}</p>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      <TrafficChart
        trafficData={trafficData}
        isLoading={showChartSkeleton}
        totalRequests={analyticsData?.summary.totalRequests}
        scopeLabel={t.projects.monitoring.allDomains}
        compact
      />
        </>
      )}

      {/* Connected Services bar */}
      <button
        onClick={() => {
          const projectId = projectData.id || id;
          if (!projectId || projectId === "undefined") return;
          setActiveTab("services");
          window.history.replaceState({}, "", `/projects/${projectId}/services`);
        }}
        className="w-full bg-card rounded-2xl border border-border/50 px-4 py-3 flex items-center justify-between hover:bg-accent/50 transition-colors group"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-success-bg flex items-center justify-center">
            <UiIcon name="layers" className="size-3.5 text-success" />
          </div>
          <span className="text-[13px] font-medium text-foreground">
            {t.projects.overview.services}
          </span>
          {serviceCount > 0 && (
            <span className="text-[11px] font-semibold text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded-md">
              {serviceCount}
            </span>
          )}
          {services.length > 0 && (
            <div className="flex items-center gap-1 ms-1">
              {services.slice(0, 4).map((svc) => (
                <div
                  key={svc.id}
                  title={svc.name}
                  className="w-6 h-6 rounded-md bg-muted/50 flex items-center justify-center"
                >
                  <ServiceIcon service={svc} className="size-3" />
                </div>
              ))}
              {services.length > 4 && (
                <span className="text-[10px] text-muted-foreground/60 ms-0.5">
                  +{services.length - 4}
                </span>
              )}
            </div>
          )}
          {serviceCount === 0 && (
            <span className="text-xs text-muted-foreground">
              {t.projects.overview.noServicesConnected}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span className="text-[12px]">{t.projects.overview.manage}</span>
          <UiIcon name="chevron-right" className="size-3.5 group-hover:translate-x-0.5 transition-transform rtl:rotate-180" />
        </div>
      </button>

      {/* Top paths (compact) */}
      {hasDomain && topPaths.length > 0 && (
        <div className="bg-card rounded-2xl border border-border/50 px-4 py-3.5">
          <div className="flex items-center gap-2 mb-3">
            <UiIcon name="chart-bar" className="size-3.5 text-primary" />
            <span className="text-[13px] font-semibold text-foreground">
              {t.projects.overview.topPaths}
            </span>
          </div>
          <div className="space-y-2">
            {topPaths.slice(0, 5).map((p, idx) => (
              <div key={idx} className="flex items-center gap-3">
                <span className="text-[12px] text-muted-foreground font-medium truncate flex-1 min-w-0">
                  {p.path}
                </span>
                <span className="text-[11px] font-medium text-primary shrink-0">
                  {p.percentage}%
                </span>
                <div className="w-20 bg-muted/50 rounded-full h-1.5 shrink-0 overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full"
                    style={{ width: `${p.percentage}%` }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground/60 shrink-0 w-14 text-end">
                  {interpolate(t.projects.overview.requestCount, { count: String(p.count) })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/* ── Sub-components ────────────────────────────────────────────────── */

const ICON_COLORS: Record<string, { bg: string; text: string }> = {
  primary: { bg: "bg-primary/10", text: "text-primary" },
  orange: { bg: "bg-orange-500/10", text: "text-orange-500" },
  blue: { bg: "bg-blue-500/10", text: "text-blue-500" },
  emerald: { bg: "bg-success-bg", text: "text-success" },
};

function Card({
  title,
  icon: Icon,
  iconColor = "primary",
  children,
}: {
  title: string;
  icon: IconName;
  iconColor?: keyof typeof ICON_COLORS;
  children: React.ReactNode;
}) {
  const colors = ICON_COLORS[iconColor] || ICON_COLORS.primary;
  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${colors.bg}`}>
          <UiIcon name={Icon} className={`size-4 ${colors.text}`} />
        </div>
        <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
      </div>
      <div className="px-5 py-4 space-y-3">{children}</div>
    </div>
  );
}

function Item({ label, value, loading }: { label: string; value: string; loading?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {loading ? (
        <div className="h-[14px] w-24 rounded bg-muted-foreground/20 animate-pulse" />
      ) : (
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground sm:max-w-[200px]">
          {value}
        </span>
      )}
    </div>
  );
}

function StatusItem({
  label,
  active,
  loading,
  t,
}: {
  label: string;
  active: boolean;
  loading?: boolean;
  t: Dictionary;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      {loading ? (
        <div className="h-[18px] w-14 rounded-full bg-muted-foreground/20 animate-pulse" />
      ) : (
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
            active ? "bg-success-bg text-success" : "bg-muted/60 text-muted-foreground/60"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${active ? "bg-success-solid" : "bg-muted-foreground/30"}`}
          />
          {active ? t.projects.overview.statusActive : t.projects.overview.statusOff}
        </span>
      )}
    </div>
  );
}
