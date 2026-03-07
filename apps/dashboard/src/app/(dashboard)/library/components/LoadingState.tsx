import React from "react";

const LoadingState: React.FC = () => {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-900 border-t-transparent mx-auto mb-4"></div>
      <p className="text-sm text-gray-600">Loading repositories...</p>
    </div>
  );
};

export default LoadingState;
