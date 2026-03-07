import React from "react";

const OwnerSelectorSkeleton: React.FC = () => {
  return (
    <div className="mb-6">
      <div className="h-5 w-32 bg-gray-200 rounded mb-3 animate-pulse"></div>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-2 px-3 py-2 rounded-full   border border-gray-200 bg-white animate-pulse"
          >
            <div className="w-5 h-5 rounded-full bg-gray-200"></div>
            <div className="flex flex-col gap-1">
              <div className="h-4 w-24 bg-gray-200 rounded-full"></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default OwnerSelectorSkeleton;

