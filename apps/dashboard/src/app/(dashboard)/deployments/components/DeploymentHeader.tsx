"use client";

import React from "react";
import { TrendingUp, Activity, AlertCircle, Clock } from "lucide-react";

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
  const failureRate = stats.total > 0 ? Math.round((failureCount / stats.total) * 100) : 0;
  const successRate = stats.total > 0 ? Math.round((stats.success / stats.total) * 100) : 0;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      {/* Total Deployments */}
      <div className="bg-white rounded-[20px] p-3 sm:p-5 hover:border-black/[0.12] transition-all">
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-br from-indigo-50 to-indigo-100 flex items-center justify-center flex-shrink-0">
            <Activity className="w-4 h-4 sm:w-5 sm:h-5 text-indigo-600" strokeWidth={2.5} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[9px] sm:text-xs font-semibold text-black/50 uppercase tracking-wider mb-0.5 sm:mb-1">Total</p>
            <div className="flex items-baseline gap-1.5 sm:gap-2 flex-wrap">
              <p className="text-lg sm:text-2xl font-bold text-black">{stats.total}</p>
              {projectCount !== undefined && (
                <span className="text-[10px] sm:text-xs text-black/40 font-medium">
                  {projectCount} {projectCount === 1 ? 'project' : 'projects'}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Successful */}
      <div className="bg-white rounded-[20px] p-3 sm:p-5 hover:border-black/[0.12] transition-all">
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-br from-indigo-50 to-indigo-100 flex items-center justify-center flex-shrink-0">
            <TrendingUp className="w-4 h-4 sm:w-5 sm:h-5 text-indigo-600" strokeWidth={2.5} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[9px] sm:text-xs font-semibold text-black/50 uppercase tracking-wider mb-0.5 sm:mb-1">Success</p>
            <div className="flex items-baseline gap-1.5 sm:gap-2 flex-wrap">
              <p className="text-lg sm:text-2xl font-bold text-black">{stats.success}</p>
              <span className="text-[9px] sm:text-xs font-semibold text-indigo-600 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-md bg-indigo-50">
                {successRate}%
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Failed + Canceled */}
      <div className="bg-white rounded-[20px] p-3 sm:p-5 hover:border-black/[0.12] transition-all">
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-br from-indigo-50 to-indigo-100 flex items-center justify-center flex-shrink-0">
            <AlertCircle className="w-4 h-4 sm:w-5 sm:h-5 text-indigo-600" strokeWidth={2.5} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[9px] sm:text-xs font-semibold text-black/50 uppercase tracking-wider mb-0.5 sm:mb-1">Failed</p>
            <div className="flex items-baseline gap-1.5 sm:gap-2 flex-wrap">
              <p className="text-lg sm:text-2xl font-bold text-black">{failureCount}</p>
              <span className="text-[9px] sm:text-xs font-semibold text-indigo-600 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-md bg-indigo-50">
                {failureRate}%
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Building + Pending */}
      <div className="bg-white rounded-[20px] p-3 sm:p-5 hover:border-black/[0.12] transition-all">
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-br from-indigo-50 to-indigo-100 flex items-center justify-center flex-shrink-0">
            <Clock className="w-4 h-4 sm:w-5 sm:h-5 text-indigo-600" strokeWidth={2.5} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[9px] sm:text-xs font-semibold text-black/50 uppercase tracking-wider mb-0.5 sm:mb-1">Active</p>
            <div className="flex items-baseline gap-1.5 sm:gap-2 flex-wrap">
              <p className="text-lg sm:text-2xl font-bold text-black">
                {(stats.building || 0) + (stats.pending || 0)}
              </p>
              <span className="text-[10px] sm:text-xs text-black/40 font-medium">
                {(stats.building || 0) + (stats.pending || 0) > 0 ? 'building now' : 'none'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
