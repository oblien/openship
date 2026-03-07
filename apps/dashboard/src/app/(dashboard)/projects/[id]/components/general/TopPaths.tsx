"use client";
import React, { useState } from "react";
import { generateIcon } from "@/utils/icons";

interface PathData {
  path: string;
  count: number;
  percentage: string;
}

interface Props {
  paths: PathData[];
}

export const TopPaths: React.FC<Props> = ({ paths }) => {
  const [showAll, setShowAll] = useState(false);
  
  const displayedPaths = showAll ? paths : paths.slice(0, 5);
  const hasMorePaths = paths.length > 5;

  return (
    <div className="bg-white rounded-[20px] border border-black/5 p-5">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          {generateIcon('trend%20up-79-1681196106.png', 24, 'rgb(79, 70, 229)')}
          <h3 className="text-base font-semibold text-black">Top Paths</h3>
        </div>
        {hasMorePaths && (
          <button
            onClick={() => setShowAll(!showAll)}
            className="text-xs font-medium text-indigo-600 hover:text-indigo-700 transition-colors"
          >
            {showAll ? 'Show Less' : `+${paths.length - 5}`}
          </button>
        )}
      </div>
      <div className="space-y-4">
        {displayedPaths.map((path, idx) => (
          <div key={idx}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-black/70 font-medium truncate pr-2">{path.path}</span>
              <span className="text-xs font-medium text-indigo-600">{path.percentage}%</span>
            </div>
            <div className="w-full bg-black/5 rounded-full h-2 overflow-hidden">
              <div 
                className="h-full bg-indigo-600 rounded-full transition-all"
                style={{ width: `${path.percentage}%` }}
              ></div>
            </div>
            <p className="text-xs text-black/40 mt-1">{path.count} requests</p>
          </div>
        ))}
      </div>
    </div>
  );
};
