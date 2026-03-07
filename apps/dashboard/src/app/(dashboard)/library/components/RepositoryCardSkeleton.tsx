import React from "react";

const RepositoryCardSkeleton: React.FC = () => {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 animate-pulse">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="h-5 bg-gray-200 rounded-full w-3/4 mb-2"></div>
          <div className="flex items-center gap-2">
            <div className="h-3 bg-gray-200 rounded-full w-16"></div>
          </div>
        </div>
      </div>

      {/* Description */}
      <div className="mb-4 space-y-2">
        <div className="h-4 bg-gray-200 rounded-full w-full"></div>
        <div className="h-4 bg-gray-200 rounded-full w-2/3"></div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 mb-4">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-gray-200"></div>
          <div className="h-3 bg-gray-200 rounded-full w-16"></div>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 bg-gray-200 rounded-full"></div>
          <div className="h-3 bg-gray-200 rounded w-8"></div>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 bg-gray-200 rounded-full"></div>
          <div className="h-3 bg-gray-200 rounded-full w-8"></div>
        </div>
        <div className="h-3 bg-gray-200 rounded-full w-12"></div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2">
        <div className="flex-1 h-10 bg-gray-200 rounded-full"></div>
        <div className="flex-1 h-10 bg-gray-200 rounded-full"></div>
      </div>
    </div>
  );
};

export default RepositoryCardSkeleton;

