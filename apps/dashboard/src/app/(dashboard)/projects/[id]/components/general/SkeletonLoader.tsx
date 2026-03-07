import React from "react";

// Fixed heights for skeleton bars to avoid hydration mismatches
const SKELETON_BAR_HEIGHTS = [
  45, 62, 38, 71, 55, 42, 68, 49, 75, 33, 
  58, 44, 66, 52, 39, 73, 47, 61, 35, 69, 
  51, 43, 64, 56
];

export const TrafficChartSkeleton = () => {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 h-[320px] flex flex-col animate-pulse">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-gray-200/50"></div>
          <div>
            <div className="h-6 w-40 bg-gray-200/50 rounded-2xl mb-2"></div>
            <div className="h-4 w-32 bg-gray-200/30 rounded-2xl"></div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="h-10 w-40 bg-gray-200/50 rounded-2xl"></div>
          <div className="h-5 w-20 bg-gray-200/30 rounded-2xl"></div>
        </div>
      </div>
      <div className="flex-1 flex items-end gap-1.5">
        {SKELETON_BAR_HEIGHTS.map((height, i) => (
          <div
            key={i}
            className="flex-1 bg-gray-200/50 rounded-t-2xl"
            style={{ height: `${height}%` }}
          ></div>
        ))}
      </div>
      <div className="flex justify-between mt-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-3 w-10 bg-gray-200/30 rounded-2xl"></div>
        ))}
      </div>
    </div>
  );
};

export const TopPathsSkeleton = () => {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 h-[320px] flex flex-col animate-pulse">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-gray-200/50"></div>
          <div className="h-6 w-32 bg-gray-200/50 rounded-2xl"></div>
        </div>
        <div className="h-5 w-20 bg-gray-200/30 rounded-2xl"></div>
      </div>
      <div className="space-y-5 flex-1">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="flex items-center justify-between mb-2">
              <div className="h-4 w-32 bg-gray-200/50 rounded-2xl"></div>
              <div className="h-4 w-16 bg-gray-200/30 rounded-2xl"></div>
            </div>
            <div className="w-full h-2.5 bg-gray-200/50 rounded-2xl"></div>
            <div className="h-3 w-20 bg-gray-200/30 rounded-2xl"></div>
          </div>
        ))}
      </div>
    </div>
  );
};

export const StatsCardsSkeleton = () => {
  return (
    <div className="grid grid-cols-4 gap-4 h-[100px]">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="bg-white border border-gray-200 rounded-2xl p-4 h-full flex items-center animate-pulse"
        >
          <div className="flex items-center gap-3 w-full">
            <div className="w-12 h-12 rounded-2xl bg-gray-200/50 flex-shrink-0"></div>
            <div className="flex-1 min-w-0">
              <div className="h-6 w-20 bg-gray-200/50 rounded-2xl mb-2"></div>
              <div className="h-4 w-24 bg-gray-200/30 rounded-2xl mb-1"></div>
              <div className="h-3 w-20 bg-gray-200/30 rounded-2xl"></div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export const ProductionUrlSkeleton = () => {
  return (
    <div className="bg-gradient-to-br from-gray-50 to-gray-100 rounded-2xl border border-gray-200 p-6 h-[100px] flex items-center animate-pulse">
      <div className="flex items-center gap-4 flex-1">
        <div className="w-12 h-12 bg-gray-200/50 rounded-2xl flex-shrink-0"></div>
        <div className="flex-1 min-w-0">
          <div className="h-4 w-32 bg-gray-200/30 rounded-2xl mb-2"></div>
          <div className="h-5 w-40 bg-gray-200/50 rounded-2xl"></div>
        </div>
      </div>
    </div>
  );
};

export const ProjectIdentitySkeleton = () => {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden animate-pulse">
      <div className="bg-gray-50 px-6 py-5 border-b border-gray-200 flex items-center gap-3">
        <div className="w-12 h-12 rounded-2xl bg-gray-200/50"></div>
        <div>
          <div className="h-6 w-40 bg-gray-200/50 rounded-2xl mb-2"></div>
          <div className="h-4 w-48 bg-gray-200/30 rounded-2xl"></div>
        </div>
      </div>
      
      <div className="p-6 space-y-5">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i}>
            <div className="flex items-center justify-between mb-3">
              <div className="h-5 w-32 bg-gray-200/50 rounded-2xl"></div>
              <div className="h-4 w-16 bg-gray-200/30 rounded-2xl"></div>
            </div>
            <div className="p-4 bg-gray-50 rounded-2xl">
              <div className="h-5 w-full bg-gray-200/50 rounded-2xl"></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export const ProjectInfoSkeleton = () => {
  return (
    <>
      <div className="bg-white rounded-2xl border border-gray-200 p-6 animate-pulse">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-12 h-12 rounded-2xl bg-gray-200/50"></div>
          <div className="h-6 w-36 bg-gray-200/50 rounded-2xl"></div>
        </div>
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <div className="w-5 h-5 rounded-xl bg-gray-200/50"></div>
              <div className="flex-1">
                <div className="h-4 w-20 bg-gray-200/50 rounded-2xl mb-2"></div>
                <div className="h-4 w-32 bg-gray-200/30 rounded-2xl"></div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-gradient-to-br from-gray-50 to-gray-100 rounded-2xl border border-gray-200 p-6 animate-pulse">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-gray-200/50 rounded-2xl"></div>
            <div>
              <div className="h-5 w-32 bg-gray-200/50 rounded-2xl mb-2"></div>
              <div className="h-4 w-36 bg-gray-200/30 rounded-2xl"></div>
            </div>
          </div>
        </div>
        <div className="w-full h-12 bg-gray-200/50 rounded-2xl"></div>
        <div className="h-4 w-40 bg-gray-200/30 rounded-2xl mt-4 mx-auto"></div>
      </div>
    </>
  );
};
