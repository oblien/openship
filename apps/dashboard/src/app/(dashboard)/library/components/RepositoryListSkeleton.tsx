import React from "react";
import RepositoryCardSkeleton from "./RepositoryCardSkeleton";

interface RepositoryListSkeletonProps {
  count?: number;
}

const RepositoryListSkeleton: React.FC<RepositoryListSkeletonProps> = ({ count = 6 }) => {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <RepositoryCardSkeleton key={i} />
      ))}
    </div>
  );
};

export default RepositoryListSkeleton;

