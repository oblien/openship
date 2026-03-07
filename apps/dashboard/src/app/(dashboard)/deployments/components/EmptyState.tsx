"use client";

import React from "react";
import { Rocket, SearchX } from "lucide-react";
import { generateIcon } from "@/utils/icons";

interface EmptyStateProps {
  hasFilters: boolean;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ hasFilters }) => {
  if (hasFilters) {
    return (
      <div className="bg-white rounded-[20px] border border-black/5 shadow-sm p-16 text-center">
        <div className="max-w-md mx-auto">
          <div className="w-20 h-20 bg-black/5 rounded-full flex items-center justify-center mx-auto mb-5 border border-black/10">
            <SearchX className="w-10 h-10 text-black/30" />
          </div>
          <h3 className="text-xl font-bold text-black mb-2">No deployments found</h3>
          <p className="text-sm text-black/50 leading-relaxed">
            We couldn't find any deployments matching your search or filter criteria. Try adjusting your filters or clearing your search.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-br from-white to-black/[0.02] rounded-[20px] border border-black/5 shadow-sm p-20 text-center">
      <div className="max-w-lg mx-auto">
        {/* Icon */}
        <div className="w-24 h-24 bg-gradient-to-br from-black/5 to-black/10 rounded-2xl flex items-center justify-center mx-auto mb-6 border border-black/10 shadow-sm">
          {generateIcon('space%20rocket-84-1687505465.png', 48, 'rgb(0, 0, 0, 0.4)')}
        </div>

        {/* Title */}
        <h3 className="text-2xl font-bold text-black mb-3">No deployments yet</h3>
        
        {/* Description */}
        <p className="text-base text-black/60 leading-relaxed mb-8">
          Your deployment history will appear here once you start deploying your project. Each deployment will show commit details, build status, and performance metrics.
        </p>

        {/* Info Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-8">
          <div className="bg-white/80 rounded-xl border border-black/5 p-4">
            <div className="w-10 h-10 bg-emerald-50 rounded-lg flex items-center justify-center mx-auto mb-3 border border-emerald-200">
              {generateIcon('flash-109-1689918656.png', 20, 'rgb(5, 150, 105)')}
            </div>
            <p className="text-xs font-semibold text-black/70">Auto Deploy</p>
            <p className="text-xs text-black/50 mt-1">Push to deploy</p>
          </div>

          <div className="bg-white/80 rounded-xl border border-black/5 p-4">
            <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center mx-auto mb-3 border border-blue-200">
              {generateIcon('terminal-184-1658431404.png', 20, 'rgb(37, 99, 235)')}
            </div>
            <p className="text-xs font-semibold text-black/70">Build Logs</p>
            <p className="text-xs text-black/50 mt-1">Real-time updates</p>
          </div>

          <div className="bg-white/80 rounded-xl border border-black/5 p-4">
            <div className="w-10 h-10 bg-purple-50 rounded-lg flex items-center justify-center mx-auto mb-3 border border-purple-200">
              {generateIcon('git%20branch-159-1658431404.png', 20, 'rgb(168, 85, 247)')}
            </div>
            <p className="text-xs font-semibold text-black/70">Git History</p>
            <p className="text-xs text-black/50 mt-1">Track commits</p>
          </div>
        </div>
      </div>
    </div>
  );
};

