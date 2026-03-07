'use client';

import React from 'react';

export const OverviewSkeleton: React.FC = () => {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Header skeleton */}
      <div className="flex justify-between items-start">
        <div className="space-y-2">
          <div className="h-8 w-48 bg-black/5 rounded-lg" />
          <div className="h-4 w-72 bg-black/5 rounded" />
        </div>
        <div className="h-5 w-32 bg-black/5 rounded" />
      </div>

      {/* Stats grid skeleton */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {Array(6).fill(0).map((_, i) => (
          <div key={i} className="bg-white rounded-[20px] border border-black/5 p-5">
            <div className="flex items-start justify-between mb-4">
              <div className="w-11 h-11 rounded-xl bg-black/5" />
            </div>
            <div className="space-y-2">
              <div className="h-7 w-20 bg-black/5 rounded" />
              <div className="h-4 w-28 bg-black/5 rounded" />
            </div>
          </div>
        ))}
      </div>

      {/* Quick links skeleton */}
      <div className="bg-white rounded-[20px] border border-black/5 p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 bg-black/5 rounded-xl" />
          <div className="space-y-2">
            <div className="h-5 w-32 bg-black/5 rounded" />
            <div className="h-3 w-24 bg-black/5 rounded" />
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {Array(6).fill(0).map((_, i) => (
            <div key={i} className="flex flex-col items-center p-4 rounded-xl border border-black/5">
              <div className="w-11 h-11 rounded-xl bg-black/5 mb-3" />
              <div className="h-4 w-20 bg-black/5 rounded mb-1" />
              <div className="h-3 w-16 bg-black/5 rounded" />
            </div>
          ))}
        </div>
      </div>

      {/* Charts skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {Array(2).fill(0).map((_, i) => (
          <div key={i} className="bg-white rounded-[20px] border border-black/5 overflow-hidden">
            <div className="px-6 py-4 border-b border-black/5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-black/5 rounded-xl" />
                <div className="space-y-2">
                  <div className="h-5 w-28 bg-black/5 rounded" />
                  <div className="h-4 w-20 bg-black/5 rounded" />
                </div>
              </div>
            </div>
            <div className="p-6">
              <div className="h-36 bg-black/5 rounded-xl" />
            </div>
          </div>
        ))}
      </div>

      {/* Cards skeleton */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {Array(4).fill(0).map((_, i) => (
          <div key={i} className="bg-white rounded-[20px] border border-black/5 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-black/5 rounded-xl" />
              <div className="space-y-2">
                <div className="h-5 w-24 bg-black/5 rounded" />
                <div className="h-3 w-16 bg-black/5 rounded" />
              </div>
            </div>
            <div className="h-24 bg-black/5 rounded-xl" />
          </div>
        ))}
      </div>
    </div>
  );
};

export default OverviewSkeleton;

