"use client";

import React from "react";
import { Rocket, CheckCircle2, XCircle, Loader2 } from "lucide-react";

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
  const failureCount = (stats.failed || 0) + (stats.canceled || 0);
  const successRate = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;
  const activeCount = (stats.building || 0) + (stats.pending || 0);

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Rocket className="size-4 text-primary" />
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Total</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-semibold text-foreground">{stats.total}</span>
              {projectCount !== undefined && (
                <span className="text-[10px] text-muted-foreground">
                  {projectCount} project{projectCount !== 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Success */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
            <CheckCircle2 className="size-4 text-emerald-500" />
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Success</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-semibold text-foreground">{stats.success}</span>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                {successRate}%
              </span>
            </div>
          </div>
        </div>

        {/* Failed */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center shrink-0">
            <XCircle className="size-4 text-red-500" />
          </div>
          <div>
            <span className="text-sm text-muted-foreground">Failed</span>
            <p className="text-lg font-semibold text-foreground">{failureCount}</p>
          </div>
        </div>

        {/* In Progress */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
            <Loader2 className={`size-4 text-amber-500${activeCount > 0 ? " animate-spin" : ""}`} />
          </div>
          <div>
            <span className="text-sm text-muted-foreground">In Progress</span>
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-semibold text-foreground">{activeCount}</span>
              {activeCount > 0 && (
                <span className="text-[10px] text-muted-foreground">building now</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
