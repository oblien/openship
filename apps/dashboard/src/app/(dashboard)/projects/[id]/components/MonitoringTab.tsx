"use client";

import React from "react";
import { ArrowUpDown, Gauge, Server, Users } from "lucide-react";
import {
  TrafficChart,
  TopPaths,
  StatsCards,
} from "./general";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useAnalyticsData } from "@/hooks/useProjectEndpoints";
import { useI18n, interpolate } from "@/components/i18n-provider";

export const MonitoringTab = () => {
  const { id, selectedDomain } = useProjectSettings();
  const { t } = useI18n();
  // Atomic analytics fetch — own state, own loading, no context coupling.
  // The hook backs onto the same module-level caches as OverviewTab so
  // both tabs share one network request per endpoint.
  const { data: analyticsData, isLoading: isLoadingAnalytics } = useAnalyticsData(id, selectedDomain);
  const hasAnalytics = !!analyticsData;

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num?.toString() || "0";
  };

  const stats = analyticsData
    ? [
        {
          label: t.projects.stats.serverRequests,
          value: formatNumber(analyticsData.summary?.uniqueRequests),
          icon: <Server className="size-4" />,
          subtext: interpolate(t.projects.stats.requestsSubtext, {
            total: formatNumber(analyticsData.summary?.totalRequests),
            avg: String(analyticsData.summary?.avgRequestsPerHour),
          }),
        },
        {
          label: t.projects.stats.uniqueIPs,
          value: formatNumber(analyticsData.summary?.uniqueIPs),
          icon: <Users className="size-4" />,
          subtext: interpolate(t.projects.stats.uniqueIPsSubtext, {
            pct: String(analyticsData.summary?.uniqueIPsPercentage),
          }),
        },
        {
          label: t.projects.stats.avgResponse,
          value: `${analyticsData.performance?.avgResponseTimeMs?.toFixed(2) || "N/A "}ms`,
          icon: <Gauge className="size-4" />,
          subtext: t.projects.stats.responseTime,
        },
        {
          label: t.projects.stats.bandwidthOut,
          value: analyticsData.bandwidth?.totalOutFormatted || "N/A",
          icon: <ArrowUpDown className="size-4" />,
          subtext: interpolate(t.projects.stats.bandwidthInSubtext, {
            value: analyticsData.bandwidth?.totalInFormatted,
          }),
        },
      ]
    : [
        {
          label: t.projects.stats.serverRequests,
          value: isLoadingAnalytics ? "..." : "0",
          icon: <Server className="size-4" />,
          subtext: isLoadingAnalytics ? t.projects.stats.loading : t.projects.stats.noTraffic,
        },
        {
          label: t.projects.stats.uniqueIPs,
          value: isLoadingAnalytics ? "..." : "0",
          icon: <Users className="size-4" />,
          subtext: isLoadingAnalytics ? t.projects.stats.loading : t.projects.stats.noVisitors,
        },
        {
          label: t.projects.stats.avgResponse,
          value: isLoadingAnalytics ? "..." : "N/A",
          icon: <Gauge className="size-4" />,
          subtext: isLoadingAnalytics ? t.projects.stats.loading : t.projects.stats.waitingRequests,
        },
        {
          label: t.projects.stats.bandwidth,
          value: isLoadingAnalytics ? "..." : "0 B",
          icon: <ArrowUpDown className="size-4" />,
          subtext: isLoadingAnalytics ? t.projects.stats.loading : t.projects.stats.noTransfer,
        },
      ];

  const trafficData = analyticsData?.trafficByHour || [];
  const topPaths = analyticsData?.topPaths || [];
  const dateRange = analyticsData
    ? `${new Date(analyticsData.summary.firstRequest).toLocaleDateString()} - ${new Date(analyticsData.summary.lastRequest).toLocaleDateString()}`
    : undefined;

  return (
    <div className="space-y-5">
      {!isLoadingAnalytics && !hasAnalytics && (
        <div className="rounded-2xl border border-border/50 bg-card px-5 py-4">
          <p className="text-sm font-medium text-foreground">{t.projects.monitoring.noDataTitle}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.projects.monitoring.noDataDescription}
          </p>
        </div>
      )}
      <TrafficChart
        trafficData={trafficData}
        isLoading={isLoadingAnalytics}
        dateRange={dateRange}
        totalRequests={analyticsData?.summary.totalRequests}
      />
      <StatsCards stats={stats} />
      {topPaths.length > 0 && <TopPaths paths={topPaths} />}
    </div>
  );
};
