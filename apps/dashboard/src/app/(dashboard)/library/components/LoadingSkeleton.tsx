"use client";

import React from "react";

export function LoadingSkeleton() {
  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="px-5 py-4 border-b border-border/50">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-9 h-9 bg-muted rounded-xl animate-pulse" />
          <div className="space-y-2">
            <div className="h-4 w-28 bg-muted rounded animate-pulse" />
            <div className="h-3 w-20 bg-muted rounded animate-pulse" />
          </div>
        </div>
        <div className="flex items-center gap-2 mb-4">
          <div className="h-10 w-28 bg-muted rounded-xl animate-pulse" />
          <div className="h-10 w-28 bg-muted rounded-xl animate-pulse" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-10 flex-1 bg-muted rounded-xl animate-pulse" />
          <div className="h-10 w-32 bg-muted rounded-xl animate-pulse" />
          <div className="h-10 w-20 bg-muted rounded-xl animate-pulse" />
        </div>
      </div>
      <div className="divide-y divide-border/50">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="px-5 py-4 flex items-center gap-4 animate-pulse">
            <div className="w-10 h-10 bg-muted rounded-xl" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-32 bg-muted rounded" />
              <div className="h-3 w-48 bg-muted rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
