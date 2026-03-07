"use client";

import React from "react";

export const LoadingSkeleton = () => {
  return (
    <div className="space-y-5">
      {/* Header Skeleton */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="bg-white rounded-[20px] border border-black/5 p-6 animate-pulse"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-11 h-11 bg-black/5 rounded-xl"></div>
              <div className="h-4 bg-black/5 rounded w-24"></div>
            </div>
            <div className="h-10 bg-black/5 rounded-lg w-20 mb-2"></div>
            <div className="h-3 bg-black/5 rounded w-16"></div>
          </div>
        ))}
      </div>

      {/* Filters Skeleton */}
      <div className="bg-white rounded-[20px] border border-black/5 p-5 animate-pulse">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="h-9 bg-black/5 rounded-full w-32"></div>
            <div className="h-9 bg-black/5 rounded-full w-24"></div>
            <div className="h-9 bg-black/5 rounded-full w-20"></div>
          </div>
          <div className="h-10 bg-black/5 rounded-full w-72"></div>
        </div>
      </div>

      {/* Cards Skeleton */}
      <div className="space-y-4">
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className="bg-white rounded-[20px] border border-black/5 p-6 animate-pulse"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="h-7 bg-black/5 rounded-full w-24"></div>
                <div className="h-7 bg-black/5 rounded-full w-20"></div>
              </div>
              <div className="h-8 bg-black/5 rounded-full w-28"></div>
            </div>
            <div className="h-5 bg-black/5 rounded w-3/4 mb-3"></div>
            <div className="flex items-center gap-3 mb-4">
              <div className="h-6 bg-black/5 rounded w-20"></div>
              <div className="h-4 bg-black/5 rounded w-32"></div>
            </div>
            <div className="flex items-center gap-4">
              <div className="h-4 bg-black/5 rounded w-24"></div>
              <div className="h-4 bg-black/5 rounded w-20"></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

