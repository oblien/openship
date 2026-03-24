"use client";

import React from "react";
import {
  TrafficChart,
  TopPaths,
  StatsCards,
} from "./general";
import { useProjectSettings } from "@/context/ProjectSettingsContext";

export const MonitoringTab = () => {
  const { analyticsData, isLoadingAnalytics } = useProjectSettings();

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
          icon: "server%20transfer-55-1658435258.png",
          subtext: `${formatNumber(analyticsData.summary?.totalRequests)} total, ${analyticsData.summary?.avgRequestsPerHour}/hr avg`,
        },
        {
          label: "Unique IPs",
          value: formatNumber(analyticsData.summary?.uniqueIPs),
          icon: "3%20users-246-1658436041.png",
          subtext: `${analyticsData.summary?.uniqueIPsPercentage}% of total`,
        },
        {
          label: "Avg Response",
          value: `${analyticsData.performance?.avgResponseTimeMs?.toFixed(2) || "N/A "}ms`,
          icon: "flash-109-1689918656.png",
          subtext: "Response time",
        },
        {
          label: "Bandwidth Out",
          value: analyticsData.bandwidth?.totalOutFormatted || "N/A",
          icon: "servers%20connect%203-61-1658435258.png",
          subtext: `${analyticsData.bandwidth?.totalInFormatted} in`,
        },
      ]
    : [
        { label: "Server Requests", value: "...", icon: "trend%20up-79-1681196106.png", subtext: "Loading..." },
        { label: "Unique IPs", value: "...", icon: "3%20users-246-1658436041.png", subtext: "Loading..." },
        { label: "Avg Response", value: "...", icon: "flash-109-1689918656.png", subtext: "Loading..." },
        { label: "Bandwidth", value: "...", icon: "servers%20connect%203-61-1658435258.png", subtext: "Loading..." },
      ];

  const trafficData = analyticsData?.trafficByHour || [];
  const topPaths = analyticsData?.topPaths || [];
  const dateRange = analyticsData
    ? `${new Date(analyticsData.summary.firstRequest).toLocaleDateString()} - ${new Date(analyticsData.summary.lastRequest).toLocaleDateString()}`
    : undefined;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <TrafficChart
            trafficData={trafficData}
            isLoading={isLoadingAnalytics}
            dateRange={dateRange}
            totalRequests={analyticsData?.summary.totalRequests}
          />
          <StatsCards stats={stats} />
        </div>
        <div className="space-y-5">
          {topPaths.length > 0 && <TopPaths paths={topPaths} />}
        </div>
      </div>
    </div>
  );
};
