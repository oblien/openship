"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React from "react";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface DeploymentHeaderProps {
  stats: {
    total: number;
    success: number;
    failed: number;
    building: number;
    pending?: number;
    canceled?: number;
  };
  projectCount?: number;
}

export const DeploymentHeader: React.FC<DeploymentHeaderProps> = ({ stats, projectCount }) => {
  const { t } = useI18n();
  const failureCount = (stats.failed || 0) + (stats.canceled || 0);
  const successRate = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;
  const activeCount = (stats.building || 0) + (stats.pending || 0);

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <UiIcon name="rocket" className="size-4 text-primary" />
          </div>
          <div>
            <span className="text-sm text-muted-foreground">{t.deployments.stats.total}</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-semibold text-foreground">{stats.total}</span>
              {projectCount !== undefined && (
                <span className="text-[10px] text-muted-foreground">
                  {interpolate(
                    projectCount === 1
                      ? t.deployments.stats.projectCountOne
                      : t.deployments.stats.projectCountOther,
                    { count: String(projectCount) },
                  )}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Success */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-success-bg flex items-center justify-center shrink-0">
            <UiIcon name="check-circle" className="size-4 text-success" />
          </div>
          <div>
            <span className="text-sm text-muted-foreground">{t.deployments.stats.success}</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-semibold text-foreground">{stats.success}</span>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-success-bg text-success">
                {successRate}%
              </span>
            </div>
          </div>
        </div>

        {/* Failed */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-danger-bg flex items-center justify-center shrink-0">
            <UiIcon name="x-circle" className="size-4 text-danger" />
          </div>
          <div>
            <span className="text-sm text-muted-foreground">{t.deployments.stats.failed}</span>
            <p className="text-lg font-semibold text-foreground">{failureCount}</p>
          </div>
        </div>

        {/* In Progress */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-warning-bg flex items-center justify-center shrink-0">
            <UiIcon name="spinner" className={`size-4 text-warning${activeCount > 0 ? " animate-spin" : ""}`} />
          </div>
          <div>
            <span className="text-sm text-muted-foreground">{t.deployments.stats.inProgress}</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-semibold text-foreground">{activeCount}</span>
              {activeCount > 0 && (
                <span className="text-[10px] text-muted-foreground">{t.deployments.stats.buildingNow}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
