import React from "react";

const RepositoryFiltersSkeleton: React.FC = () => {
  return (
    <div className="mb-6 flex flex-col sm:flex-row gap-3">
      {/* Search skeleton */}
      <div className="flex-1 h-10 bg-white border border-gray-200 rounded-full animate-pulse"></div>

      {/* Visibility filter skeleton */}
      <div className="w-full sm:w-40 h-10 bg-white border border-gray-200 rounded-full animate-pulse"></div>

      {/* Sort skeleton */}
      <div className="w-full sm:w-40 h-10 bg-white border border-gray-200 rounded-full animate-pulse"></div>
    </div>
  );
};

export default RepositoryFiltersSkeleton;

