"use client";

import React from "react";
import { ArrowUpDown, Gauge, Server, Users } from "lucide-react";
import {
  TrafficChart,
  TopPaths,
  StatsCards,
} from "./general";
import { useProjectSettings } from "@/context/ProjectSettingsContext";

export const MonitoringTab = () => {
  const { analyticsData, isLoadingAnalytics } = useProjectSettings();
  const hasAnalytics = !!analyticsData;

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num?.toString() || "0";
  };

  const stats = analyticsData
    ? [
        {
          label: "Server Requests",
          value: formatNumber(analyticsData.summary?.uniqueRequests),
          icon: <Server className="size-4" />,
          subtext: `${formatNumber(analyticsData.summary?.totalRequests)} total, ${analyticsData.summary?.avgRequestsPerHour}/hr avg`,
        },
        {
          label: "Unique IPs",
          value: formatNumber(analyticsData.summary?.uniqueIPs),
          icon: <Users className="size-4" />,
          subtext: `${analyticsData.summary?.uniqueIPsPercentage}% of total`,
        },
        {
          label: "Avg Response",
          value: `${analyticsData.performance?.avgResponseTimeMs?.toFixed(2) || "N/A "}ms`,
          icon: <Gauge className="size-4" />,
          subtext: "Response time",
        },
        {
          label: "Bandwidth Out",
          value: analyticsData.bandwidth?.totalOutFormatted || "N/A",
          icon: <ArrowUpDown className="size-4" />,
          subtext: `${analyticsData.bandwidth?.totalInFormatted} in`,
        },
      ]
    : [
        {
          label: "Server Requests",
          value: isLoadingAnalytics ? "..." : "0",
          icon: <Server className="size-4" />,
          subtext: isLoadingAnalytics ? "Loading..." : "No traffic recorded yet",
        },
        {
          label: "Unique IPs",
          value: isLoadingAnalytics ? "..." : "0",
          icon: <Users className="size-4" />,
          subtext: isLoadingAnalytics ? "Loading..." : "No visitors yet",
        },
        {
          label: "Avg Response",
          value: isLoadingAnalytics ? "..." : "N/A",
          icon: <Gauge className="size-4" />,
          subtext: isLoadingAnalytics ? "Loading..." : "Waiting for requests",
        },
        {
          label: "Bandwidth",
          value: isLoadingAnalytics ? "..." : "0 B",
          icon: <ArrowUpDown className="size-4" />,
          subtext: isLoadingAnalytics ? "Loading..." : "No transfer yet",
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
          <p className="text-sm font-medium text-foreground">No monitoring data yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Analytics will appear here after the deployed app starts receiving traffic.
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
