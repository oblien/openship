"use client";

import React from "react";

export const LoadingSkeleton = () => {
  return (
    <div className="space-y-4">
      {/* Header Skeleton */}
      <div className="bg-card rounded-2xl border border-border/50 p-5 animate-pulse">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="w-8 h-8 bg-muted rounded-lg shrink-0" />
              <div className="space-y-1.5">
                <div className="h-3 bg-muted rounded w-14" />
                <div className="h-5 bg-muted rounded w-8" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Filters Skeleton */}
      <div className="bg-card rounded-2xl border border-border/50 px-4 py-3 animate-pulse">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="h-8 bg-muted rounded-lg w-16"></div>
            <div className="h-8 bg-muted rounded-lg w-20"></div>
            <div className="h-8 bg-muted rounded-lg w-18"></div>
          </div>
          <div className="h-9 bg-muted rounded-lg w-60"></div>
        </div>
      </div>

      {/* Cards Skeleton */}
      <div className="bg-card rounded-2xl border border-border/50 divide-y divide-border/50">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="px-4 py-3.5 flex items-center gap-4 animate-pulse">
            <div className="w-10 h-10 bg-muted rounded-xl shrink-0"></div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="h-4 bg-muted rounded w-32"></div>
                <div className="h-5 bg-muted rounded-full w-16"></div>
              </div>
              <div className="flex items-center gap-2">
                <div className="h-3 bg-muted rounded w-48"></div>
                <div className="h-3 bg-muted rounded w-12"></div>
              </div>
            </div>
            <div className="h-7 bg-muted rounded-lg w-20 shrink-0"></div>
          </div>
        ))}
      </div>
    </div>
  );
};

